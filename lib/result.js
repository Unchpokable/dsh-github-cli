/**
 * Model-facing result envelopes and small text helpers.
 *
 * Every tool returns a structured value. `render` turns that value into the
 * text the model reads; the value stays available to programmatic callers.
 * Plans and applied results share one shape so a caller can always tell whether
 * something was written.
 */

/** Build the text block array a DSH tool render callback returns. */
export function toolText(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

/**
 * A successful, applied operation.
 *
 * @param {object} input - result fields.
 * @returns {object} model-facing value.
 */
export function success(input) {
  const {
    operation,
    repo = null,
    url = null,
    summary,
    data = null,
    warnings = [],
    next = [],
    journalId = null,
  } = input;
  return {
    ok: true,
    operation,
    repo,
    url,
    summary,
    data,
    warnings: [...warnings],
    next: [...next],
    applied: true,
    journal_id: journalId,
    plan: null,
  };
}

/**
 * A plan that has not changed anything.
 *
 * @param {object} input - operation, plan, and optional next steps.
 * @returns {object} model-facing value.
 */
export function planResult(input) {
  const { operation, plan, repo = null, url = null, next = [] } = input;
  return {
    ok: true,
    operation,
    repo,
    url,
    summary: plan.summary,
    data: null,
    warnings: [...(plan.warnings ?? [])],
    next: [...next],
    applied: false,
    journal_id: null,
    plan,
  };
}

/**
 * A next-step hint the model can follow without guessing arguments.
 *
 * @param {string} tool - tool name.
 * @param {object} args - complete argument object for that tool.
 * @param {string} reason - why the step is useful.
 * @returns {{tool: string, args: object, reason: string}}
 */
export function nextStep(tool, args, reason) {
  return { tool, args, reason };
}

/** Clip text to a character bound, appending an explicit marker. */
export function truncateText(input, max) {
  const text = String(input ?? '');
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n[...]`;
}

/** Keep the last `count` lines, with a marker when lines were dropped. */
export function tailLines(input, count) {
  const text = String(input ?? '');
  if (!Number.isFinite(count) || count <= 0) return '';
  const lines = text.split(/\r?\n/);
  if (lines.length <= count) return text;
  return [...lines.slice(-count), `[... ${lines.length - count} earlier lines omitted]`].join('\n');
}

/** Remove ANSI escape sequences from terminal-oriented output. */
export function stripAnsi(input) {
  // eslint-disable-next-line no-control-regex
  return String(input ?? '').replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Human-readable count with a plural suffix when the caller supplies one. */
export function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * A conservative default renderer for a value that has no dedicated renderer.
 * It avoids dumping large objects and never prints a raw token.
 */
export function renderDefault(value) {
  if (value === null || value === undefined) return 'ok';
  if (typeof value === 'string') return value;
  if (value.summary) {
    const lines = [value.summary];
    if (value.url) lines.push(value.url);
    if (Array.isArray(value.warnings) && value.warnings.length > 0) {
      for (const warning of value.warnings) lines.push(`warning: ${warning}`);
    }
    return lines.join('\n');
  }
  return truncateText(JSON.stringify(value, null, 2), 20_000);
}

/** Decide whether a value is a plan rather than an applied result. */
export function isPlan(value) {
  return value?.applied === false && value?.plan !== null && value?.plan !== undefined;
}

/** Stable plan identity used for approval prompts and journal entries. */
export function planId(operation, parts = []) {
  const seed = `${operation}:${parts.join('|')}:${Date.now()}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `plan_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
