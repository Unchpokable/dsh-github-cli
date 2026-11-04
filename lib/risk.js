/**
 * Risk tiers and write gates.
 *
 * R0 read and R1 local writes run without a GitHub approval. R2 remote writes
 * ask the session's approval channel. R3 destructive and R4 admin operations
 * additionally require `allowDestructive`/`allowAdmin`, `apply: true`, and a
 * typed `confirm` string that matches the plan.
 */

import { GitHubError } from './errors.js';

/** Ordered risk vocabulary. */
export const RISK = Object.freeze({
  read: 'read',
  local: 'local',
  write: 'write',
  destructive: 'destructive',
  admin: 'admin',
});

const RANK = Object.freeze({
  [RISK.read]: 0,
  [RISK.local]: 1,
  [RISK.write]: 2,
  [RISK.destructive]: 3,
  [RISK.admin]: 4,
});

/** Numeric rank of a risk; unknown risks are treated as admin. */
export function riskRank(risk) {
  return RANK[risk] ?? RANK.admin;
}

/** True when `risk` is at least `threshold`. */
export function riskAtLeast(risk, threshold) {
  return riskRank(risk) >= riskRank(threshold);
}

/** True for risks that write outside the local workspace. */
export function isRemoteWrite(risk) {
  return riskRank(risk) >= RANK.write;
}

/** True for risks that need `apply` and `confirm`. */
export function isGuarded(risk) {
  return riskRank(risk) >= RANK.destructive;
}

/**
 * Normalize the `requireApproval` config into one boolean per risk.
 *
 * A bare `false` disables the approval prompt but never widens the destructive
 * or admin gates: those remain blocked by `allowDestructive`/`allowAdmin`.
 *
 * @param {boolean|object|undefined} value - raw config value.
 * @returns {{write: boolean, destructive: boolean, admin: boolean}}
 */
export function approvalPolicy(value) {
  if (value === false) return { write: false, destructive: false, admin: false };
  if (value === true || value === undefined || value === null) {
    return { write: true, destructive: true, admin: true };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return {
      write: value.write !== false,
      destructive: value.destructive !== false,
      admin: value.admin !== false,
    };
  }
  return { write: true, destructive: true, admin: true };
}

/** True when an operation at this risk needs the approval channel. */
export function requiresApproval(config, risk) {
  if (!isRemoteWrite(risk)) return false;
  const policy = approvalPolicy(config?.requireApproval);
  if (riskRank(risk) >= RANK.admin) return policy.admin;
  if (riskRank(risk) >= RANK.destructive) return policy.destructive;
  return policy.write;
}

/**
 * Enforce the destructive/admin gates before an operation can apply.
 *
 * @param {object} input - risk, config, arguments, plan.
 * @param {string} input.risk - operation risk.
 * @param {object} input.config - resolved plugin config.
 * @param {object} input.args - tool arguments.
 * @param {object} [input.plan] - plan with an optional `confirm` string.
 * @returns {{planOnly: boolean, reason: string}} whether to stop at the plan.
 * @throws {GitHubError} when the policy forbids the operation or confirm is wrong.
 */
export function gateRisk({ risk, config, args = {}, plan = null }) {
  const guarded = isGuarded(risk);
  if (!guarded) return { planOnly: args.dry_run === true, reason: '' };

  // A plan is read-only and is always allowed, even when the corresponding
  // apply gate is disabled. This lets a caller inspect a destructive operation
  // before deciding whether to enable it.
  if (args.dry_run === true) return { planOnly: true, reason: 'dry run' };
  if (args.apply !== true) {
    return { planOnly: true, reason: 'destructive operations need apply: true' };
  }

  if (riskRank(risk) >= RANK.admin) {
    if (config.allowAdmin !== true) {
      throw new GitHubError(
        'This operation changes organization or security settings, but admin operations are disabled in this plugin configuration.',
        {
          code: 'policy',
          hint: 'Set allowAdmin: true in the plugin config after reviewing the operation, or run it manually in the GitHub UI.',
        },
      );
    }
  } else if (riskRank(risk) >= RANK.destructive && config.allowDestructive !== true) {
    throw new GitHubError(
      'This operation is destructive, but destructive operations are disabled in this plugin configuration.',
      {
        code: 'policy',
        hint: 'Set allowDestructive: true in the plugin config after reviewing the plan, or run it manually in the GitHub UI.',
      },
    );
  }

  const expected = plan?.confirm ?? null;
  if (expected !== null) {
    const supplied = typeof args.confirm === 'string' ? args.confirm.trim() : '';
    if (supplied !== expected) {
      throw new GitHubError(
        `Confirmation does not match this plan. Expected "${expected}".`,
        {
          code: 'validation',
          hint: `Pass confirm: "${expected}" together with apply: true.`,
        },
      );
    }
  }

  return { planOnly: false, reason: '' };
}

/** Human label for a risk tier. */
export function riskLabel(risk) {
  switch (risk) {
    case RISK.read: return 'read';
    case RISK.local: return 'local write';
    case RISK.write: return 'remote write';
    case RISK.destructive: return 'destructive write';
    case RISK.admin: return 'admin/security write';
    default: return 'unknown';
  }
}

/** True when the operation must not run concurrently with another write. */
export function isSerialWrite(risk) {
  return riskRank(risk) >= RANK.write;
}
