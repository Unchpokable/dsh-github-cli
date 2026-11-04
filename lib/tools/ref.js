/** `github_ref` — branches and tags. */

import { getOperation, listOperations, runOperation } from '../ops/registry.js';
import { renderValue } from '../render/common.js';
import '../ops/ref.js';

const REPO_PARAMETER = {
  type: 'string',
  description: 'Repository as "owner/name" or a GitHub URL. Defaults to the cwd binding, then defaultRepo.',
};

export function registerRefTool(ctx, runtime) {
  const actions = listOperations('github_ref').map((operation) => operation.action);
  const { config } = runtime;

  ctx.tools.register({
    name: 'github_ref',
    description: `Manage branches and tags. Actions: ${actions.join(', ')}. create adds a branch or lightweight tag at from (default branch when omitted); delete is destructive and needs apply, confirm, and allowDestructive.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions, description: 'Operation to perform.' },
        repo: REPO_PARAMETER,
        ref: {
          type: 'string',
          description: 'Branch or tag name.',
        },
        from: {
          type: 'string',
          description: 'Branch, tag, or commit SHA to create from. Defaults to the repository default branch.',
        },
        kind: {
          type: 'string',
          enum: ['branch', 'tag'],
          description: 'Reference kind; branch by default.',
        },
        allow_protected: {
          type: 'boolean',
          description: 'Allow deleting a protected branch.',
        },
        dry_run: { type: 'boolean', description: 'Preview without writing.' },
        apply: { type: 'boolean', description: 'Apply a destructive plan.' },
        confirm: { type: 'string', description: 'Exact confirmation string from the plan.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    timeoutMs: config.timeoutMs + 5_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const operation = getOperation('github_ref', String(args.action ?? '').trim());
      return runOperation(operation, args, { ...runtime, exec });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `github_ref ${args.action ?? ''} ${args.ref ?? args.repo ?? ''}`.trim(),
      kind: args.action === 'list' || args.action === 'view' ? 'read' : 'edit',
    }),
  });
}
