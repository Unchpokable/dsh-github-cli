/** `github_org` — organizations, members, teams, team repositories, settings. */

import { getOperation, listOperations, runOperation } from '../ops/registry.js';
import { renderValue } from '../render/common.js';
import '../ops/org.js';

export function registerOrgTool(ctx, runtime) {
  const actions = listOperations('github_org').map((operation) => operation.action);
  const { config } = runtime;

  ctx.tools.register({
    name: 'github_org',
    description: `Inspect and manage GitHub organizations. Actions: ${actions.join(', ')}. Members, teams, team repository access, and settings are admin-risk: they need allowAdmin, apply, and often the plan's confirm string. Creating an organization itself stays a manual UI action.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions, description: 'Operation to perform.' },
        org: { type: 'string', description: 'Organization login. Defaults to defaultOrg.' },
        login: { type: 'string', description: 'GitHub user login for member/team operations.' },
        role: { type: 'string', enum: ['member', 'admin', 'maintainer'], description: 'Role for invite/team membership.' },
        team_slug: { type: 'string', description: 'Team slug for team operations.' },
        name: { type: 'string', description: 'Team name or organization display name.' },
        description: { type: 'string', description: 'Team or organization description.' },
        privacy: { type: 'string', enum: ['closed', 'secret'], description: 'Team privacy.' },
        parent_team_id: { type: 'integer', description: 'Parent team id.' },
        repo: { type: 'string', description: 'Repository "owner/name" for team access.' },
        permission: { type: 'string', enum: ['pull', 'triage', 'push', 'maintain', 'admin'], description: 'Team repository permission.' },
        company: { type: 'string', description: 'Organization company setting.' },
        blog: { type: 'string', description: 'Organization blog setting.' },
        location: { type: 'string', description: 'Organization location setting.' },
        email: { type: 'string', description: 'Organization email setting.' },
        twitter_username: { type: 'string', description: 'Organization Twitter setting.' },
        members_can_create_repositories: { type: 'boolean', description: 'Organization setting.' },
        members_can_create_teams: { type: 'boolean', description: 'Organization setting.' },
        default_repository_permission: { type: 'string', description: 'Organization default repository permission.' },
        apply: { type: 'boolean', description: 'Apply an admin plan.' },
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
      const operation = getOperation('github_org', String(args.action ?? '').trim());
      return runOperation(operation, args, { ...runtime, exec });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `github_org ${args.action ?? ''} ${args.org ?? ''}`.trim(),
      kind: ['list', 'view', 'repos', 'members', 'teams', 'team', 'settings_get'].includes(args.action) ? 'read' : 'edit',
    }),
  });
}
