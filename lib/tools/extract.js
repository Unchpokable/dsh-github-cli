/** `github_extract` — history-preserving or snapshot repository extraction. */

import { getOperation, listOperations, runOperation } from '../ops/registry.js';
import { renderPlan, renderValue } from '../render/common.js';
import '../ops/extract.js';

export function registerExtractTool(ctx, runtime) {
  const actions = listOperations('github_extract').map((operation) => operation.action);
  const { config } = runtime;

  ctx.tools.register({
    name: 'github_extract',
    description: `Extract a directory from a repository into a new repository, or link a target repository back as a submodule. Actions: ${actions.join(', ')}. plan reads the source tree and checks the destination; apply creates the destination, runs subtree-split or snapshot in a scratch clone, then pushes. link replaces a directory with a gitlink on a new branch and opens a PR. Both are destructive and need allowDestructive, apply, and the plan's confirm string. The source repository is never rewritten.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions, description: 'Operation to perform.' },
        source: {
          type: 'object',
          description: 'Source repository, ref, and path.',
          properties: {
            repo: { type: 'string', description: 'Source repository "owner/name".' },
            ref: { type: 'string', description: 'Branch, tag, or commit; defaults to the default branch.' },
            path: { type: 'string', description: 'Directory to extract.' },
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Multiple directories for filter-repo extraction.',
            },
          },
          required: ['repo'],
        },
        destination: {
          type: 'object',
          description: 'Destination repository.',
          properties: {
            owner: { type: 'string', description: 'Destination owner or organization.' },
            name: { type: 'string', description: 'Destination repository name.' },
            visibility: { type: 'string', enum: ['private', 'public', 'internal'], description: 'Visibility; private by default.' },
            create: { type: 'boolean', description: 'Create the destination; defaults to true.' },
          },
          required: ['name'],
        },
        target: {
          type: 'object',
          description: 'Target repository for link.',
          properties: {
            repo: { type: 'string', description: 'Repository to link as a submodule.' },
          },
          required: ['repo'],
        },
        branch: { type: 'string', description: 'Branch for the link commit and pull request.' },
        open_pr: { type: 'boolean', description: 'Open a pull request for the link; defaults to true.' },
        title: { type: 'string', description: 'Pull request title for link.' },
        message: { type: 'string', description: 'Commit message for link.' },
        history: {
          type: 'string',
          enum: ['preserve', 'snapshot'],
          description: 'Preserve rewritten history (default) or create one snapshot commit.',
        },
        allow_history_rewrite: {
          type: 'boolean',
          description: 'Acknowledge that preserve mode rewrites commit hashes in the temporary clone.',
        },
        path: { type: 'string', description: 'Scratch path for cleanup.' },
        dry_run: { type: 'boolean', description: 'Preview without creating or pushing.' },
        apply: { type: 'boolean', description: 'Apply the plan.' },
        confirm: { type: 'string', description: 'Exact confirmation string from the plan.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{
        type: 'text',
        text: value?.plan ? renderPlan(value.plan) : renderValue(value),
      }],
    },
    timeoutMs: config.longTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const operation = getOperation('github_extract', String(args.action ?? '').trim());
      return runOperation(operation, args, { ...runtime, exec });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `github_extract ${args.action ?? ''} ${args.source?.path ?? ''}`.trim(),
      kind: 'edit',
    }),
  });
}
