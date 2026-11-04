/** `github_release` — releases and assets. */

import { getOperation, listOperations, runOperation } from '../ops/registry.js';
import { renderValue } from '../render/common.js';
import '../ops/release.js';

export function registerReleaseTool(ctx, runtime) {
  const actions = listOperations('github_release').map((operation) => operation.action);
  const { config } = runtime;

  ctx.tools.register({
    name: 'github_release',
    description: `Manage GitHub releases. Actions: ${actions.join(', ')}. Create/edit/delete releases, upload a workspace file as an asset, or download release assets to the workspace. Delete is destructive and needs apply, confirm, and allowDestructive.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions, description: 'Operation to perform.' },
        repo: { type: 'string', description: 'Repository "owner/name".' },
        tag: { type: 'string', description: 'Release tag.' },
        release: { type: 'string', description: 'Release id or tag for view/edit/delete.' },
        name: { type: 'string', description: 'Release name.' },
        body: { type: 'string', description: 'Release notes.' },
        target: { type: 'string', description: 'Target commitish for create.' },
        draft: { type: 'boolean', description: 'Draft release.' },
        prerelease: { type: 'boolean', description: 'Prerelease.' },
        generate_release_notes: { type: 'boolean', description: 'Generate release notes.' },
        file: { type: 'string', description: 'Workspace file to upload.' },
        dir: { type: 'string', description: 'Workspace directory for download.' },
        pattern: { type: 'string', description: 'Asset name pattern for download.' },
        clobber: { type: 'boolean', description: 'Overwrite existing assets.' },
        apply: { type: 'boolean', description: 'Apply a guarded plan.' },
        confirm: { type: 'string', description: 'Exact confirmation string from the plan.' },
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
      const operation = getOperation('github_release', String(args.action ?? '').trim());
      return runOperation(operation, args, { ...runtime, exec });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `github_release ${args.action ?? ''} ${args.tag ?? args.release ?? ''}`.trim(),
      kind: args.action === 'list' || args.action === 'view' || args.action === 'download' ? 'read' : 'edit',
    }),
  });
}
