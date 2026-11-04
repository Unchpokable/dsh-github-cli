/** The GitHub client surface an operation receives through `ctx.gh`. */

import { apiJson, apiList, apiRequest, apiText } from './rest.js';
import { graphql, graphqlResponse } from './graphql.js';
import { ghCommand, ghRun } from './exec.js';

/**
 * Build the default client. Tests pass a fake with the same methods through
 * `runOperation(..., { gh })`.
 */
export function createGhClient() {
  return { apiJson, apiList, apiRequest, apiText, graphql, graphqlResponse, command: ghCommand, run: ghRun };
}
