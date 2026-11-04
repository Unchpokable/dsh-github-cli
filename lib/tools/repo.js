/**
 * `github_repo` — repository lifecycle, topics, and access.
 *
 * The tool is a thin dispatcher over the repository operations. Keeping the
 * schema in one place makes the action set discoverable and lets each operation
 * own its validation and approval plan.
 */

import { getOperation, listOperations, runOperation } from '../ops/registry.js';
import { renderValue } from '../render/common.js';
import '../ops/repo.js';

const REPO_PARAMETER = {
  type: 'string',
  description: 'Repository as "owner/name" or a GitHub URL. Defaults to the cwd binding, then defaultRepo.',
};

export function registerRepoTool(ctx, runtime) {
  const actions = listOperations('github_repo').map((operation) => operation.action);
  const { config } = runtime;

  ctx.tools.register({
    name: 'github_repo',
    description: `Manage GitHub repositories. Actions: ${actions.join(', ')}. Create a repository in a user account or organization, edit metadata, archive it, set topics, or manage collaborator access. Remote writes ask for approval; destructive access removal also needs apply, confirm, and allowDestructive.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: 'Operation to perform.',
        },
        repo: REPO_PARAMETER,
        org: {
          type: 'string',
          description: 'Organization for list/create. Defaults to defaultOrg.',
        },
        owner: {
          type: 'string',
          description: 'User or organization that owns the repository for create/list.',
        },
        name: {
          type: 'string',
          description: 'Repository name for create.',
        },
        visibility: {
          type: 'string',
          enum: ['private', 'public', 'internal'],
          description: 'Repository visibility; private by default.',
        },
        description: {
          type: 'string',
          description: 'Repository description.',
        },
        homepage: {
          type: 'string',
          description: 'Repository homepage URL.',
        },
        topics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Topic names.',
        },
        auto_init: {
          type: 'boolean',
          description: 'Initialize the repository with a README and default branch.',
        },
        template: {
          type: 'string',
          description: 'Template repository as "owner/name" for create.',
        },
        include_all_branches: {
          type: 'boolean',
          description: 'With template, copy all branches instead of only the default branch.',
        },
        gitignore: {
          type: 'string',
          description: 'GitHub gitignore template name for create.',
        },
        license: {
          type: 'string',
          description: 'GitHub license template for create.',
        },
        team_id: {
          type: 'integer',
          description: 'Organization team id granted access on create.',
        },
        default_branch: {
          type: 'string',
          description: 'Default branch name for edit.',
        },
        archived: {
          type: 'boolean',
          description: 'Archived state for edit.',
        },
        has_issues: {
          type: 'boolean',
          description: 'Enable issues.',
        },
        has_wiki: {
          type: 'boolean',
          description: 'Enable wiki.',
        },
        has_projects: {
          type: 'boolean',
          description: 'Enable projects.',
        },
        has_discussions: {
          type: 'boolean',
          description: 'Enable discussions.',
        },
        user: {
          type: 'string',
          description: 'GitHub login for access_add, access_set, or access_remove.',
        },
        permission: {
          type: 'string',
          enum: ['pull', 'triage', 'push', 'maintain', 'admin'],
          description: 'Collaborator permission for access_add/access_set.',
        },
        new_owner: {
          type: 'string',
          description: 'Target owner for transfer.',
        },
        new_name: {
          type: 'string',
          description: 'New repository name for rename.',
        },
        team_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Organization team ids granted access during transfer.',
        },
        type: {
          type: 'string',
          description: 'Repository type filter for list: all, public, private, forks, sources, member.',
        },
        sort: {
          type: 'string',
          description: 'Sort field for list: created, updated, pushed, full_name.',
        },
        direction: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort direction for list.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum items for list; defaults to 100.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Validate and preview without writing.',
        },
        apply: {
          type: 'boolean',
          description: 'Apply a destructive plan. Requires confirm.',
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
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    timeoutMs: config.timeoutMs + 5_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = String(args.action ?? '').trim();
      const operation = getOperation('github_repo', action);
      return runOperation(operation, args, { ...runtime, exec });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `github_repo ${args.action ?? ''} ${args.repo ?? args.name ?? ''}`.trim(),
      kind: args.action === 'list' || args.action === 'view' || args.action === 'access_list' ? 'read' : 'edit',
    }),
  });
}
