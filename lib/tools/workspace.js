/**
 * `github_workspace` — local checkout context and safe git operations.
 *
 * These tools only write inside the session workspace. They never ask the GitHub
 * approval channel, but they run through the DSH subprocess/sandbox services.
 */

import { getOperation, listOperations, runOperation } from '../ops/registry.js';
import { renderValue } from '../render/common.js';
import '../ops/workspace.js';

const REPO_PARAMETER = {
  type: 'string',
  description: 'Repository as "owner/name" or a GitHub URL. Defaults to the cwd binding, then defaultRepo.',
};

export function registerWorkspaceTool(ctx, runtime) {
  const actions = listOperations('github_workspace').map((operation) => operation.action);
  const { config } = runtime;

  ctx.tools.register({
    name: 'github_workspace',
    description: `Inspect or change the local checkout context. Actions: ${actions.join(', ')}. clone creates a checkout and binds it to the repository; checkout switches a branch or PR; sync fetches and fast-forwards without force; worktree creates a second checkout. Local writes stay under workspaceRoot or the session directory.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: 'Operation to perform.',
        },
        repo: REPO_PARAMETER,
        path: {
          type: 'string',
          description: 'Checkout directory. Defaults to the session cwd or a path under workspaceRoot.',
        },
        branch: {
          type: 'string',
          description: 'Branch to clone or check out.',
        },
        ref: {
          type: 'string',
          description: 'Branch, tag, or commit to check out.',
        },
        pr: {
          type: 'string',
          description: 'Pull request number or URL to check out.',
        },
        depth: {
          type: 'integer',
          description: 'Shallow clone depth.',
        },
        submodules: {
          type: 'boolean',
          description: 'Clone submodules recursively.',
        },
        set_cwd: {
          type: 'boolean',
          description: 'Change the session working directory to the new checkout; defaults to true.',
        },
        remote: {
          type: 'string',
          description: 'Remote name to bind; defaults to origin.',
        },
        mode: {
          type: 'string',
          enum: ['ff-only', 'rebase', 'merge'],
          description: 'Sync mode; ff-only by default.',
        },
        allow_dirty: {
          type: 'boolean',
          description: 'Allow sync with uncommitted changes; defaults to false.',
        },
        from: {
          type: 'string',
          description: 'Base revision for a worktree.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview the operation without changing files.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    timeoutMs: config.longTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const operation = getOperation('github_workspace', String(args.action ?? '').trim());
      return runOperation(operation, args, { ...runtime, exec });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `github_workspace ${args.action ?? ''} ${args.repo ?? args.path ?? ''}`.trim(),
      kind: 'read',
    }),
  });
}
