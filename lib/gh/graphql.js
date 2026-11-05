/**
 * GraphQL transport. `gh api graphql --input -` accepts a JSON body, which lets
 * us pass typed variables instead of shell-quoting a query string.
 */

import { apiRequest } from './rest.js';
import { GitHubError } from '../errors.js';

/**
 * Execute one GraphQL query or mutation.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {string} query - GraphQL document.
 * @param {object} [variables] - GraphQL variables.
 * @param {object} [options] - abort signal, host, timeout.
 * @returns {Promise<any>} the `data` object.
 */
export async function graphql(config, query, variables = {}, options = {}) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new GitHubError('A GraphQL query is required.', {
      code: 'validation',
      hint: 'Pass a query document and optional variables.',
    });
  }
  const isMutation = /(^|\s)mutation(\s|\{|\()/i.test(query);
  const response = await apiRequest(config, 'graphql', {
    method: 'POST',
    input: { query, variables },
    signal: options.signal,
    host: options.host,
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    accept: 'application/vnd.github+json',
    retryServerErrors: !isMutation,
  });

  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new GitHubError('GitHub returned a GraphQL response this tool could not parse.', {
      code: 'unknown',
      details: response.body.slice(0, 500),
    });
  }

  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    const message = parsed.errors.map((error) => error?.message).filter(Boolean).join('; ') || 'GraphQL request failed.';
    const type = parsed.errors.find((error) => error?.type)?.type ?? null;
    throw new GitHubError(`GitHub GraphQL error${type ? ` (${type})` : ''}: ${message}`, {
      code: type === 'NOT_FOUND' ? 'not_found' : 'graphql',
      hint: 'Check the query fields and the account permissions for the requested resource.',
      details: JSON.stringify(parsed.errors).slice(0, 2000),
    });
  }

  return parsed?.data ?? null;
}

/** Convenience wrapper returning the whole response, including extensions. */
export async function graphqlResponse(config, query, variables = {}, options = {}) {
  const isMutation = /(^|\s)mutation(\s|\{|\()/i.test(String(query ?? ''));
  const response = await apiRequest(config, 'graphql', {
    method: 'POST',
    input: { query, variables },
    signal: options.signal,
    host: options.host,
    timeoutMs: options.timeoutMs,
    retryServerErrors: !isMutation,
  });
  try {
    return JSON.parse(response.body);
  } catch {
    throw new GitHubError('GitHub returned a GraphQL response this tool could not parse.', {
      code: 'unknown',
      details: response.body.slice(0, 500),
    });
  }
}
