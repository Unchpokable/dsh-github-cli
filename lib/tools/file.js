/**
 * `github_file` — read, inspect, write, and delete repository files.
 *
 * Reads reuse the original Contents implementation (line numbers, paging,
 * binary detection). Writes use an explicit `sha` so an overwrite cannot
 * silently clobber a concurrent edit.
 */

import { readRepository, renderRead } from '../../read.js';
import { getOperation, listOperations, runOperation } from '../ops/registry.js';
import { renderValue } from '../render/common.js';
import '../ops/file.js';

const REPO_PARAMETER = {
  type: 'string',
  description: 'Repository as "owner/name" or a GitHub URL. Defaults to the cwd binding, then defaultRepo.',
};

export function registerFileTool(ctx, runtime) {
  const actions = ['read', ...listOperations('github_file').map((operation) => operation.action)];
  const { config } = runtime;

  ctx.tools.register({
    name: 'github_file',
    description: `Read or modify files in a GitHub repository. Actions: ${actions.join(', ')}. read returns line-numbered content or a directory/tree listing; stat inspects one path; write creates or replaces one file and requires its current sha to overwrite; delete removes one file; move/copy use the Git Data API; commit applies an atomic multi-file change set. Writes to protected branches are refused unless allow_protected is set.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: 'Operation to perform.',
        },
        repo: REPO_PARAMETER,
        ref: {
          type: 'string',
          description: 'Branch, tag, or commit SHA for read/stat.',
        },
        pr: {
          type: 'string',
          description: 'Pull request number or URL whose head to read. Mutually exclusive with ref.',
        },
        path: {
          type: 'string',
          description: 'File or directory path inside the repository.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 20 paths to read in one call.',
        },
        start_line: {
          type: 'integer',
          description: 'First line to return for read.',
        },
        end_line: {
          type: 'integer',
          description: 'Last line to return for read.',
        },
        recursive: {
          type: 'boolean',
          description: 'List a directory recursively.',
        },
        content: {
          type: 'string',
          description: 'File content for write; UTF-8 unless encoding is base64.',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          description: 'Content encoding for write; defaults to utf8.',
        },
        message: {
          type: 'string',
          description: 'Commit message for write/delete.',
        },
        branch: {
          type: 'string',
          description: 'Target branch for write/delete; defaults to the repository default branch.',
        },
        sha: {
          type: 'string',
          description: 'Current blob sha for overwrite/delete (optimistic concurrency).',
        },
        from: {
          type: 'string',
          description: 'Source path for move/copy.',
        },
        to: {
          type: 'string',
          description: 'Destination path for move/copy.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Allow move/copy to replace an existing destination.',
        },
        base_sha: {
          type: 'string',
          description: 'Expected branch head sha for an atomic commit.',
        },
        changes: {
          type: 'array',
          description: 'Atomic multi-file changes for commit.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['write', 'delete', 'move', 'copy'] },
              path: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              content: { type: 'string' },
              encoding: { type: 'string', enum: ['utf8', 'base64'] },
              mode: { type: 'string', enum: ['100644', '100755', '120000'] },
              overwrite: { type: 'boolean' },
            },
            required: ['op'],
          },
        },
        allow_protected: {
          type: 'boolean',
          description: 'Allow a direct write to a branch matched by protectedBranches.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Validate and preview without writing.',
        },
        apply: {
          type: 'boolean',
          description: 'Apply a guarded plan. Requires confirm.',
        },
        confirm: {
          type: 'string',
          description: 'Exact confirmation string from the plan.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{
        type: 'text',
        text: value && (Array.isArray(value.files) || Array.isArray(value.entries))
          ? renderRead(value)
          : renderValue(value),
      }],
    },
    timeoutMs: config.timeoutMs + 5_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = String(args.action ?? '').trim();
      if (action === 'read') {
        const readArgs = { ...args };
        if (typeof readArgs.repo !== 'string' || readArgs.repo.trim().length === 0) {
          try {
            readArgs.repo = runtime.session.resolveRepo(undefined, { cwd: runtime.session.cwd }).full;
          } catch {
            // Leave repo empty; readRepository will use defaultRepo or explain.
          }
        }
        return readRepository(config, readArgs, exec.signal);
      }
      const operation = getOperation('github_file', action);
      return runOperation(operation, args, { ...runtime, exec });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `github_file ${args.action ?? ''} ${args.path ?? args.repo ?? ''}`.trim(),
      kind: args.action === 'read' || args.action === 'stat' ? 'read' : 'edit',
    }),
  });
}
