/** `github_search` — repository, issue, code, and user search. */

import { getOperation, runOperation } from '../ops/registry.js';
import { renderValue } from '../render/common.js';
import '../ops/search.js';

export function registerSearchTool(ctx, runtime) {
  const { config } = runtime;
  ctx.tools.register({
    name: 'github_search',
    description: 'Search GitHub repositories, issues/pull requests, code, or users. Code search uses a separate rate-limit bucket and only indexes default branches; prefer narrow queries and small limits.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search'], description: 'Only search is supported.' },
        kind: { type: 'string', enum: ['repositories', 'issues', 'code', 'users'], description: 'Search kind.' },
        query: { type: 'string', description: 'GitHub search query, including qualifiers.' },
        limit: { type: 'integer', description: 'Maximum results; defaults to 30.' },
      },
      required: ['action', 'kind', 'query'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    timeoutMs: config.timeoutMs + 5_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return runOperation(getOperation('github_search', 'search'), args, { ...runtime, exec });
    },
    presentCall: (args) => ({ card: 'generic', title: `github_search ${args.kind ?? ''} ${args.query ?? ''}`.trim(), kind: 'read' }),
  });
}
