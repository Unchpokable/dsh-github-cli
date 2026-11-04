/**
 * Compatibility facade for the original GitHub transport.
 *
 * The implementation now lives in `lib/gh/` and `lib/repo.js`; existing modules
 * import from this file so the original public surface keeps working. New code
 * should import the focused modules directly.
 */

export { run, resolveGh, ghCommand, ghRun, resetGhDiscovery } from './lib/gh/exec.js';
export { apiRequest, apiText, apiJson, apiList, parseIncludedResponse, rateLimitFromHeaders } from './lib/gh/rest.js';
export { graphql, graphqlResponse } from './lib/gh/graphql.js';
export { githubError, GitHubError, redact } from './lib/errors.js';
export { parseRepo, parseRepoRef, parsePull, parseRemote, resolveRepo, normalizeHost } from './lib/repo.js';
export { shortSha, formatBytes, isoSeconds } from './lib/format.js';
