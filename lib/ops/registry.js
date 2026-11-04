/**
 * Operation registry and the single plan/apply pipeline.
 *
 * A tool is a thin schema and dispatcher. The real work is an operation
 * descriptor with a risk tier, optional validation, a prepare step, a plan, and
 * an apply step. Every operation therefore gets the same approval, confirm,
 * journal, and rendering behavior.
 */

import { GitHubError, errorCode } from '../errors.js';
import { gateRisk, requiresApproval, riskLabel, isRemoteWrite, RISK } from '../risk.js';
import { planId, planResult, success, nextStep } from '../result.js';

const registry = new Map();

/** Stable operation id, e.g. `repo.transfer`. */
export function operationId(operation) {
  if (typeof operation.operation === 'string' && operation.operation.length > 0) return operation.operation;
  const tool = operation.tool.replace(/^github_/, '');
  return `${tool}.${operation.action}`;
}

/**
 * Register an operation descriptor.
 *
 * @param {object} spec - descriptor.
 * @param {string} spec.tool - model-facing tool name.
 * @param {string} spec.action - action name within the tool.
 * @param {'read'|'local'|'write'|'destructive'|'admin'} spec.risk - risk tier.
 * @param {string[]} [spec.scopes] - GitHub token scopes usually needed.
 * @param {Function} spec.apply - async (ctx, prepared, signal) => result.
 * @param {Function} [spec.validate] - sync/async (args, ctx) => void.
 * @param {Function} [spec.prepare] - async (ctx, args) => prepared.
 * @param {Function} [spec.plan] - async (ctx, prepared) => partial plan.
 * @param {Function} [spec.verify] - async (ctx, prepared, result) => void.
 * @param {Function} [spec.render] - (value) => string.
 * @param {Function} [spec.summary] - (args) => string.
 * @param {Function} [spec.next] - (prepared, plan, args) => next steps.
 * @returns {object} the registered descriptor.
 */
export function defineOperation(spec) {
  if (spec === null || typeof spec !== 'object') throw new Error('defineOperation needs a descriptor object.');
  if (typeof spec.tool !== 'string' || spec.tool.length === 0) throw new Error('operation.tool must be a non-empty string.');
  if (typeof spec.action !== 'string' || spec.action.length === 0) throw new Error('operation.action must be a non-empty string.');
  if (!Object.values(RISK).includes(spec.risk)) throw new Error(`operation.risk must be one of ${Object.values(RISK).join(', ')}.`);
  if (typeof spec.apply !== 'function') throw new Error('operation.apply must be a function.');

  const key = `${spec.tool}.${spec.action}`;
  if (registry.has(key)) throw new Error(`operation ${key} is already registered.`);
  registry.set(key, spec);
  return spec;
}

/** Look up one operation. */
export function getOperation(tool, action) {
  const operation = registry.get(`${tool}.${action}`);
  if (!operation) {
    throw new GitHubError(`Unknown action "${action}" for ${tool}.`, {
      code: 'validation',
      hint: `Use one of: ${listOperations(tool).map((entry) => entry.action).join(', ') || '(none registered)'}.`,
    });
  }
  return operation;
}

/** List the operations registered for one tool. */
export function listOperations(tool) {
  return [...registry.values()].filter((entry) => entry.tool === tool);
}

/** Remove every registration; used by tests. */
export function clearOperations() {
  registry.clear();
}

function buildPlan(operation, ctx, prepared, args, extra = {}) {
  return {
    id: planId(operationId(operation), [prepared?.repo ?? '', extra.summary ?? prepared?.summary ?? '']),
    risk: extra.risk ?? operation.risk,
    summary: extra.summary ?? prepared?.summary ?? operation.summary?.(args, prepared) ?? `${operationId(operation)} ${prepared?.repo ?? ''}`.trim(),
    effects: extra.effects ?? prepared?.effects ?? [],
    api: extra.api ?? prepared?.api ?? [],
    commands: extra.commands ?? prepared?.commands ?? [],
    irreversible: (extra.irreversible ?? prepared?.irreversible) === true,
    confirm: extra.confirm ?? prepared?.confirm ?? null,
    warnings: extra.warnings ?? prepared?.warnings ?? [],
    repo: extra.repo ?? prepared?.repo ?? null,
    details: extra.details ?? null,
  };
}

function describePlan(plan) {
  const lines = [
    `GitHub ${riskLabel(plan.risk)}: ${plan.summary}`,
    '',
    `Risk: ${plan.risk}`,
  ];
  if (plan.repo) lines.push(`Repository: ${plan.repo}`);
  if (plan.effects.length > 0) {
    lines.push('', 'Effects:');
    for (const effect of plan.effects) lines.push(`- ${effect}`);
  }
  if (plan.irreversible) lines.push('', 'Irreversible: yes');
  if (plan.confirm) lines.push('', `Confirm: ${plan.confirm}`);
  if (plan.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}

function defaultNext(operation, plan, args) {
  if (plan.risk === RISK.read || plan.risk === RISK.local) return [];
  const applyArgs = { ...args, apply: true };
  if (plan.confirm) applyArgs.confirm = plan.confirm;
  return [nextStep(operation.tool, applyArgs, 'apply the plan')];
}

async function requestApproval(ctx, operation, plan) {
  const service = ctx.session?.ctx?.get?.('approval') ?? ctx.approval;
  if (service === undefined || service === null) {
    throw new GitHubError(
      'This GitHub write needs approval, but no approval service is available.',
      {
        code: 'policy',
        hint: 'Set requireApproval: false in the plugin config only if unattended writes are intended.',
      },
    );
  }
  if (ctx.exec?.agent === undefined) {
    throw new GitHubError('This GitHub write needs an approval request, but the call has no agent context.', {
      code: 'policy',
      hint: 'Call the tool from an agent session with an approval channel.',
    });
  }

  const outcome = await service.request({
    agent: ctx.exec.agent,
    toolName: ctx.toolName,
    callId: ctx.exec.callId,
    reason: describePlan(plan),
    signal: ctx.signal,
  });

  if (outcome === 'allowed-once') return 'allowed-once';
  if (outcome === 'rejected') {
    throw new GitHubError('The user rejected this GitHub write; nothing was sent.', { code: 'cancelled' });
  }
  if (outcome === 'cancelled') {
    throw new GitHubError('The approval request was cancelled; nothing was sent.', { code: 'cancelled' });
  }
  throw new GitHubError(
    'No approval answerer responded, so nothing was sent.',
    {
      code: 'policy',
      hint: 'Configure an approval channel or set requireApproval: false in the plugin config.',
    },
  );
}

/**
 * Run one operation through validate → prepare → plan → gate → approval →
 * apply → verify → journal.
 *
 * @param {object} operation - registered descriptor.
 * @param {object} args - tool arguments.
 * @param {object} runtime - `{config, session, exec}`.
 * @returns {Promise<object>} model-facing value (a plan or an applied result).
 */
export async function runOperation(operation, args, runtime) {
  const { config, session, exec = {} } = runtime;
  const signal = exec.signal;
  const ctx = {
    config,
    session,
    exec,
    signal,
    agent: exec.agent,
    toolName: exec.toolName ?? operation.tool,
    callId: exec.callId,
    gh: runtime.gh ?? null,
  };

  const operationName = operationId(operation);
  try {
    await operation.validate?.(args, ctx);
    const prepared = operation.prepare ? await operation.prepare(ctx, args) : { ...args };
    const planExtra = operation.plan ? await operation.plan(ctx, prepared, args) : {};
    const plan = buildPlan(operation, ctx, prepared, args, planExtra);
    const gate = gateRisk({ risk: plan.risk, config, args, plan });

    if (gate.planOnly) {
      const next = operation.next?.(prepared, plan, args) ?? defaultNext(operation, plan, args);
      return planResult({
        operation: operationName,
        plan,
        repo: plan.repo,
        next,
      });
    }

    let approval = 'not-required';
    if (requiresApproval(config, plan.risk)) {
      approval = await requestApproval(ctx, operation, plan);
    }

    const applied = await operation.apply(ctx, prepared, signal);
    await operation.verify?.(ctx, prepared, applied);

    const journal = session?.record?.({
      id: plan.id,
      operation: operationName,
      repo: applied?.repo ?? plan.repo,
      risk: plan.risk,
      planHash: plan.id,
      approval,
      result: 'success',
    });

    return success({
      operation: operationName,
      repo: applied?.repo ?? plan.repo,
      url: applied?.url ?? null,
      summary: applied?.summary ?? plan.summary,
      data: applied?.data ?? null,
      warnings: [...plan.warnings, ...(applied?.warnings ?? [])],
      next: applied?.next ?? operation.next?.(prepared, plan, args) ?? [],
      journalId: journal?.id ?? null,
    });
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    if (error?.name === 'AbortError') {
      throw new GitHubError('The GitHub operation was cancelled.', { code: 'cancelled', cause: error });
    }
    throw new GitHubError(error?.message ?? 'The GitHub operation failed.', {
      code: errorCode(error),
      details: error?.stack ? String(error.stack).slice(0, 2000) : null,
      cause: error,
    });
  }
}

/** True when an operation at this risk may run alongside other calls. */
export function isConcurrencySafe(operation) {
  return !isRemoteWrite(operation.risk);
}
