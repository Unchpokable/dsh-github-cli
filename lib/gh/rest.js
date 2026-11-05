/**
 * REST transport over `gh api`.
 *
 * `--include` gives us the HTTP status line and headers, which the original
 * transport discarded. Those headers carry the rate-limit budget, ETag, and
 * `Retry-After`; the body is separated before JSON parsing.
 */

import { ghRun } from './exec.js';
import { GitHubError, githubError, httpError } from '../errors.js';

const API_VERSION = '2022-11-28';
const DEFAULT_ACCEPT = 'application/vnd.github+json';

/**
 * Split `gh api --include` output into status, headers, and body.
 *
 * @param {string} input - raw stdout.
 * @returns {{status: number|null, headers: Record<string,string>, body: string}}
 */
export function parseIncludedResponse(input) {
  const text = String(input ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const separator = text.indexOf('\n\n');
  if (separator < 0) {
    return { status: null, headers: {}, body: text };
  }

  const head = text.slice(0, separator).split('\n');
  const body = text.slice(separator + 2);
  const statusLine = head.shift() ?? '';
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(statusLine)?.[1] ?? NaN);
  const headers = {};
  let last = null;

  for (const line of head) {
    if (/^[ \t]/.test(line) && last !== null) {
      headers[last] = `${headers[last]} ${line.trim()}`.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key.length === 0) continue;
    headers[key] = line.slice(colon + 1).trim();
    last = key;
  }

  return { status: Number.isFinite(status) ? status : null, headers, body };
}

/** Rate-limit facts from response headers. */
export function rateLimitFromHeaders(headers = {}) {
  const limit = Number(headers['x-ratelimit-limit']);
  const remaining = Number(headers['x-ratelimit-remaining']);
  const used = Number(headers['x-ratelimit-used']);
  const reset = Number(headers['x-ratelimit-reset']);
  if (!Number.isFinite(limit) && !Number.isFinite(remaining) && !Number.isFinite(reset)) return null;
  return {
    resource: headers['x-ratelimit-resource'] ?? null,
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    used: Number.isFinite(used) ? used : null,
    reset,
    reset_at: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : null,
  };
}

function labelFor(method, endpoint) {
  return `api ${method} ${endpoint}`;
}

const RETRYABLE_METHODS = new Set(['GET', 'HEAD']);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 15_000;

function abortReason() {
  const error = new Error('The GitHub request was cancelled.');
  error.name = 'AbortError';
  return error;
}

function retryDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      cleanup();
      reject(abortReason());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Decide whether one failed request can safely be repeated.
 *
 * Rate limits and 5xx on reads are safe; a write is retried only for a 429,
 * where GitHub guarantees the request was not applied.
 */
function shouldRetry(error, method, allowServerError = false) {
  if (error?.name === 'AbortError' || error?.code === 'cancelled') return false;
  if (error?.status === 429) return true;
  const repeatable = RETRYABLE_METHODS.has(method) || allowServerError;
  if (!repeatable) return false;
  if (error?.status === null || error?.status === undefined) {
    return error?.retryable === true || error?.code === 'timeout' || error?.code === 'network';
  }
  return error?.status >= 500 && error?.retryable === true;
}

function buildArgs(method, endpoint, options) {
  const args = ['api', '--include', '--method', method];
  const accept = options.accept ?? DEFAULT_ACCEPT;
  args.push('-H', `Accept: ${accept}`);
  args.push('-H', `X-GitHub-Api-Version: ${options.apiVersion ?? API_VERSION}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined || value === null) continue;
    args.push('-H', `${name}: ${value}`);
  }
  if (options.input !== undefined) args.push('--input', '-');
  if (options.host) args.push('--hostname', options.host);
  args.push(endpoint);
  return args;
}

async function requestOnce(config, endpoint, method, args, options) {
  const runner = options.ghRun ?? ghRun;
  const result = await runner(config, args, {
    stdin: options.input === undefined ? undefined : JSON.stringify(options.input),
    signal: options.signal,
    maxStdoutBytes: options.maxStdoutBytes,
    timeoutMs: options.timeoutMs,
  });
  const parsed = parseIncludedResponse(result.stdout);

  if (parsed.status !== null && parsed.status >= 400) {
    throw httpError(parsed.status, parsed.body || result.stderr, parsed.headers, labelFor(method, endpoint));
  }
  if (result.code !== 0) {
    // gh can fail before it prints a response (network, auth, invalid flag).
    const error = githubError(result, args);
    error.details = error.details ?? parsed.body ?? null;
    throw error;
  }

  return {
    status: parsed.status,
    headers: parsed.headers,
    body: parsed.body,
    rate: rateLimitFromHeaders(parsed.headers),
  };
}

/**
 * Perform one REST request and return status, headers, and body.
 *
 * GET/HEAD calls retry transient 5xx responses and network failures with a
 * short backoff; a 429 is retried for any method because GitHub guarantees it
 * was not applied. `Retry-After` is respected, capped so one tool call cannot
 * sleep indefinitely.
 *
 * Throws a structured {@link GitHubError} for HTTP errors. The original
 * `apiText`/`apiJson` behavior (throw on any non-zero exit) is preserved.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {string} endpoint - REST path, e.g. `repos/owner/name`.
 * @param {object} [options] - method, JSON body, Accept, headers, host, signal.
 * @returns {Promise<{status: number|null, headers: Record<string,string>, body: string, rate: object|null}>}
 */
export async function apiRequest(config, endpoint, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  const args = buildArgs(method, endpoint, options);
  const allowServerError = options.retryServerErrors === true;
  const configured = Number.isInteger(options.attempts) ? options.attempts : null;
  const maxAttempts = Math.max(1, Math.min(5, configured ?? (RETRYABLE_METHODS.has(method) || allowServerError ? MAX_ATTEMPTS : 1)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await requestOnce(config, endpoint, method, args, options);
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error, method, allowServerError)) throw error;
      const delay = Math.min(
        Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 500 * 2 ** (attempt - 1),
        MAX_RETRY_DELAY_MS,
      );
      await retryDelay(delay, options.signal);
    }
  }
}

/**
 * Call one REST endpoint and return the raw response body.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {string} endpoint - REST path.
 * @param {object} [options] - method, JSON body, Accept, headers, host, abort signal.
 * @returns {Promise<string>}
 */
export async function apiText(config, endpoint, options = {}) {
  const response = await apiRequest(config, endpoint, options);
  return response.body;
}

/**
 * Call one REST endpoint and parse its JSON response.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {string} endpoint - REST path.
 * @param {object} [options] - same as {@link apiRequest}.
 * @returns {Promise<any>}
 */
export async function apiJson(config, endpoint, options = {}) {
  const response = await apiRequest(config, endpoint, options);
  const text = response.body.trim();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHubError(
      `GitHub returned a response this tool could not parse (${options.method ?? 'GET'} ${endpoint}).`,
      {
        code: 'unknown',
        hint: 'Retry the call; if it persists, inspect the endpoint with github_api.',
        details: text.slice(0, 500),
      },
    );
  }
}

/**
 * Read a paged REST list, requesting pages explicitly so one huge collection
 * cannot run away with the call budget.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {string} endpoint - collection path; `?` is allowed.
 * @param {{maxPages?: number, signal?: AbortSignal, perPage?: number}} [options] - page cap and cancellation.
 * @returns {Promise<{items: any[], complete: boolean, pages: number}>}
 */
export async function apiList(config, endpoint, options = {}) {
  const maxPages = options.maxPages ?? config.maxPages ?? 10;
  const perPage = options.perPage ?? 100;
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const pageItems = await apiJson(config, `${endpoint}${separator}per_page=${perPage}&page=${page}`, {
      signal: options.signal,
      ghRun: options.ghRun,
    });
    if (!Array.isArray(pageItems)) {
      throw new GitHubError(`GitHub did not return a list for ${endpoint}.`, {
        code: 'unknown',
        hint: 'Check the endpoint and account permissions.',
      });
    }
    items.push(...pageItems);
    if (pageItems.length < perPage) return { items, complete: true, pages: page };
  }
  return { items, complete: false, pages: maxPages };
}
