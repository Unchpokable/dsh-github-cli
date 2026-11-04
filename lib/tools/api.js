/** `github_api` — generic REST/GraphQL escape hatch. */

import { getOperation, runOperation } from '../ops/registry.js';
import { renderValue } from '../render/common.js';
import { truncateText } from '../result.js';
import '../ops/api.js';

export function registerApiTool(ctx, runtime) {
  const { config } = runtime;

  ctx.tools.register({
    name: 'github_api',
    description: 'Call a GitHub REST or GraphQL endpoint that has no dedicated tool. Read-only by default: GET and GraphQL queries need no approval; writes require allowGenericApi: "write" and allow_write: true; DELETE is admin-risk and needs allowAdmin, apply, and confirm. Prefer the domain tools for repository, file, PR, issue, Actions, and organization work.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['request'], description: 'Only request is supported.' },
        path: { type: 'string', description: 'REST path relative to the API, e.g. "/repos/owner/repo".' },
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method; GET unless graphql is used.' },
        query: { type: 'object', description: 'Query parameters.' },
        body: { type: 'object', description: 'JSON request body.' },
        graphql: { type: 'string', description: 'GraphQL query or mutation document.' },
        variables: { type: 'object', description: 'GraphQL variables.' },
        select: { type: 'string', description: 'Dot path to project from the response.' },
        accept: { type: 'string', description: 'Accept header override.' },
        allow_write: { type: 'boolean', description: 'Acknowledge a generic write.' },
        dry_run: { type: 'boolean', description: 'Preview without writing.' },
        apply: { type: 'boolean', description: 'Apply a guarded plan.' },
        confirm: { type: 'string', description: 'Exact confirmation string from the plan.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{
        type: 'text',
        text: value?.data?.kind === 'api'
          ? truncateText(JSON.stringify(value.data.response, null, 2), config.maxOutputChars)
          : renderValue(value),
      }],
    },
    timeoutMs: config.timeoutMs + 5_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const operation = getOperation('github_api', String(args.action ?? 'request').trim());
      return runOperation(operation, args, { ...runtime, exec });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `github_api ${args.method ?? 'GET'} ${args.path ?? 'graphql'}`,
      kind: args.method === 'GET' || args.graphql ? 'read' : 'edit',
    }),
  });
}
