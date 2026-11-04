/**
 * Error taxonomy, GitHub CLI diagnostics, and secret redaction.
 *
 * Every failure surfaced to a model carries a stable machine code so callers can
 * branch on it, plus a hint that says what to do next. Human-readable detail is
 * bounded and redacted: `gh` and `git` can echo tokens, URLs with credentials,
 * and response bodies that contain either.
 */

const MAX_DETAIL_CHARS = 2000;

const SECRET_PATTERNS = [
  // GitHub tokens: classic, OAuth, user-to-server, server-to-server, refresh.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // Fine-grained personal access tokens.
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Generic bearer tokens in free text.
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
];

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/**
 * Remove credential-shaped values from text that is about to be shown to a
 * model, written to a log, or embedded in an error message.
 *
 * @param {unknown} input - any text-like value.
 * @returns {string} redacted text.
 */
export function redact(input) {
  let value = String(input ?? '');
  value = value.replace(PRIVATE_KEY_PATTERN, '[redacted private key]');
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, '[redacted]');
  // Authorization headers, including basic and token schemes.
  value = value.replace(/(authorization\s*:\s*(?:bearer|token|basic)\s+)[^\s,;]+/gi, '$1[redacted]');
  // Credentials embedded in an https URL.
  value = value.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]:[redacted]@');
  return value;
}

/** First non-blank line of a diagnostic stream, redacted and clipped. */
export function firstLine(text, max = MAX_DETAIL_CHARS) {
  const value = redact(text);
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, max);
  }
  return '';
}

/**
 * A structured GitHub failure.
 *
 * `code` is stable for callers; `message` is for the model; `hint` is the next
 * action. `details` is optional bounded diagnostic text.
 */
export class GitHubError extends Error {
  /**
   * @param {string} message - model-facing message.
   * @param {object} [options] - classification and remediation.
   * @param {string} [options.code] - stable code, e.g. `auth`, `not_found`.
   * @param {string} [options.hint] - what to do next.
   * @param {number|null} [options.status] - HTTP status when known.
   * @param {string|null} [options.details] - bounded, redacted diagnostic.
   * @param {boolean} [options.retryable] - whether a retry can help.
   * @param {number|null} [options.retryAfterMs] - server-provided delay.
   * @param {unknown} [options.cause] - original error.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GitHubError';
    this.code = options.code ?? 'unknown';
    this.hint = options.hint ?? '';
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.details = options.details ? redact(options.details).slice(0, MAX_DETAIL_CHARS) : null;
    this.retryable = options.retryable === true;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : null;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      status: this.status,
      retryable: this.retryable,
    };
  }
}

/** True for an abort/cancellation error from a tool call. */
export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

/** Normalize an arbitrary thrown value into an Error without losing the cause. */
export function toError(value, fallbackMessage = 'The GitHub operation failed.') {
  if (value instanceof Error) return value;
  return new Error(value === undefined || value === null ? fallbackMessage : String(value));
}

/**
 * Readable command name for diagnostics, without header and flag values.
 *
 * @param {readonly string[]} args - argv passed to gh.
 * @returns {string}
 */
export function commandLabel(args) {
  if (args[0] === 'api') {
    const endpoint = args[args.length - 1];
    const methodIndex = args.indexOf('--method');
    const method = methodIndex >= 0 ? args[methodIndex + 1] : 'GET';
    return `api ${method} ${endpoint}`;
  }
  if (args[0] === 'auth') return 'auth status';
  const positional = args.filter((arg) => !arg.startsWith('-'));
  return positional.slice(0, 2).join(' ');
}

/** True when a diagnostic points at an authentication problem. */
function looksLikeAuth(lower) {
  return lower.includes('bad credentials')
    || lower.includes('http 401')
    || lower.includes('authentication failed')
    || lower.includes('gh auth login')
    || lower.includes('not logged in');
}

/** True when a diagnostic points at a rate limit. */
function looksLikeRateLimit(lower) {
  return lower.includes('rate limit')
    || lower.includes('secondary rate')
    || lower.includes('abuse detection')
    || lower.includes('http 429');
}

/** True when a diagnostic points at a missing resource. */
function looksLikeNotFound(lower, line) {
  return lower.includes('http 404')
    || lower.includes('not found')
    || /^not found$/i.test(line);
}

/** True when a diagnostic points at insufficient permission or scope. */
function looksLikePermission(lower) {
  return lower.includes('http 403')
    || lower.includes('forbidden')
    || lower.includes('resource not accessible')
    || lower.includes('must have admin')
    || lower.includes('insufficient scope')
    || lower.includes('saml')
    || lower.includes('sso');
}

/** True when a diagnostic points at a conflict or validation failure. */
function looksLikeConflict(lower) {
  return lower.includes('http 409')
    || lower.includes('http 422')
    || lower.includes('merge conflict')
    || lower.includes('validation failed')
    || lower.includes('already exists');
}

/**
 * Translate a non-zero gh exit into an actionable, structured error.
 *
 * The messages for the four long-standing cases (auth, rate limit, 404, generic)
 * are preserved so existing callers and users see no regression.
 *
 * @param {{code: number|null, stdout: string, stderr: string}} result - child outcome.
 * @param {readonly string[]} args - argv for context.
 * @returns {GitHubError}
 */
export function githubError(result, args) {
  const detail = redact(`${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim());
  const lower = detail.toLowerCase();
  const command = commandLabel(args) || 'gh';
  const line = firstLine(detail);
  const status = Number.isInteger(result.status) ? result.status : null;

  if (looksLikeAuth(lower)) {
    return new GitHubError(
      `GitHub authentication failed (${command}): ${line}. Run \`gh auth login\`, or set GH_TOKEN for an account that can read this repository.`,
      {
        code: 'auth',
        hint: 'Run `gh auth login`, or set GH_TOKEN for an account with access. Check the active account with github_status.',
        status: status ?? 401,
        details: detail,
      },
    );
  }
  if (looksLikeRateLimit(lower)) {
    return new GitHubError(
      `GitHub API rate limit reached (${command}): ${line}. Check the authenticated account and remaining quota with github_status.`,
      {
        code: 'rate_limit',
        hint: 'Wait for the reset, check github_status for the remaining quota, or use a token with a larger budget.',
        status: status ?? 429,
        details: detail,
        retryable: true,
        retryAfterMs: retryAfterMs(result.headers),
      },
    );
  }
  if (looksLikeNotFound(lower, line)) {
    return new GitHubError(
      `GitHub returned 404 for ${command}: ${line}. Check the repository name, ref, path, or pull request number; private repositories need the repo token scope.`,
      {
        code: 'not_found',
        hint: 'Check the repository, ref, path, or number; private repositories need the repo scope.',
        status: status ?? 404,
        details: detail,
      },
    );
  }
  if (looksLikePermission(lower)) {
    return new GitHubError(
      `GitHub denied ${command}: ${line}. The token or account lacks permission for this operation.`,
      {
        code: 'permission',
        hint: 'Check the repository or organization role and the token scopes; `gh auth refresh -s <scope>` adds a scope.',
        status: status ?? 403,
        details: detail,
      },
    );
  }
  if (looksLikeConflict(lower)) {
    return new GitHubError(
      `GitHub rejected ${command}: ${line}. The resource changed or the request is not valid in its current state.`,
      {
        code: 'conflict',
        hint: 'Re-read the current state and retry with fresh values (for example the current SHA or merge state).',
        status: status ?? 409,
        details: detail,
      },
    );
  }
  const suffix = status === null ? `exit code ${result.code}` : `HTTP ${status}`;
  return new GitHubError(
    detail.length === 0 ? `gh ${command} failed with ${suffix}.` : `gh ${command} failed: ${detail.slice(0, MAX_DETAIL_CHARS)}`,
    {
      code: 'unknown',
      hint: 'Inspect the diagnostic above; use github_status to check the account and quota.',
      status,
      details: detail,
      retryable: status === null || status >= 500,
    },
  );
}

/**
 * Build an error from an HTTP response, used by the REST transport when it has
 * status and headers instead of a gh exit code.
 *
 * @param {number} status - HTTP status.
 * @param {string} body - response body.
 * @param {Record<string, string>} [headers] - response headers, lower-case keys.
 * @param {string} [command] - endpoint label.
 * @returns {GitHubError}
 */
export function httpError(status, body, headers = {}, command = 'api') {
  const detail = redact(String(body ?? '').trim());
  const lower = detail.toLowerCase();
  const line = firstLine(detail);
  const retryAfter = retryAfterMs(headers);

  if (status === 401 || looksLikeAuth(lower)) {
    return new GitHubError(
      `GitHub authentication failed (${command}): ${line || `HTTP ${status}`}. Run \`gh auth login\`, or set GH_TOKEN for an account that can read this repository.`,
      { code: 'auth', hint: 'Run `gh auth login` or use a token with access.', status, details: detail },
    );
  }
  if (status === 429 || looksLikeRateLimit(lower) || headers['x-ratelimit-remaining'] === '0') {
    return new GitHubError(
      `GitHub API rate limit reached (${command}): ${line || `HTTP ${status}`}. Check the authenticated account and remaining quota with github_status.`,
      { code: 'rate_limit', hint: 'Wait for the reset or check github_status.', status, details: detail, retryable: true, retryAfterMs: retryAfter },
    );
  }
  if (status === 404) {
    return new GitHubError(
      `GitHub returned 404 for ${command}: ${line || 'not found'}. Check the repository name, ref, path, or pull request number; private repositories need the repo token scope.`,
      { code: 'not_found', hint: 'Check the repository, ref, path, or number.', status, details: detail },
    );
  }
  if (status === 403) {
    return new GitHubError(
      `GitHub denied ${command}: ${line || 'forbidden'}. The token or account lacks permission for this operation.`,
      {
        code: 'permission',
        hint: 'Check the repository or organization role and the token scopes; `gh auth refresh -s <scope>` adds a scope.',
        status,
        details: detail,
      },
    );
  }
  if (status === 409 || status === 422) {
    return new GitHubError(
      `GitHub rejected ${command}: ${line || `HTTP ${status}`}. The resource changed or the request is not valid in its current state.`,
      { code: 'conflict', hint: 'Re-read the current state and retry with fresh values.', status, details: detail },
    );
  }
  return new GitHubError(
    `GitHub returned HTTP ${status} for ${command}${line ? `: ${line}` : ''}.`,
    {
      code: status >= 500 ? 'network' : 'unknown',
      hint: status >= 500 ? 'Retry after a short delay; check github_status if it persists.' : 'Inspect the diagnostic above.',
      status,
      details: detail,
      retryable: status >= 500 || status === 429,
      retryAfterMs: retryAfter,
    },
  );
}

/** Parse `Retry-After` or rate-limit reset headers into a millisecond delay. */
export function retryAfterMs(headers = {}) {
  const retryAfter = headers?.['retry-after'];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const reset = headers?.['x-ratelimit-reset'];
  if (reset !== undefined) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds) && seconds > 0) return Math.max(0, seconds * 1000 - Date.now());
  }
  return null;
}

/** Machine-readable code for a thrown value, without exposing a stack. */
export function errorCode(error) {
  if (error instanceof GitHubError) return error.code;
  if (isAbortError(error)) return 'cancelled';
  if (error?.code === 'ETIMEDOUT' || /timed out/i.test(error?.message ?? '')) return 'timeout';
  if (error?.code === 'ENOENT') return 'unsupported';
  return 'unknown';
}
