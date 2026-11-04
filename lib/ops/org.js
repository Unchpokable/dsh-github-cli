/**
 * Organization operations: repositories, members, invitations, teams, team
 * repositories, and a small whitelist of organization settings.
 */

import { defineOperation } from './registry.js';
import { GitHubError } from '../errors.js';

function client(ctx) {
  if (!ctx.gh) throw new GitHubError('The GitHub REST client is not available.', { code: 'unsupported' });
  return ctx.gh;
}

function orgName(ctx, args) {
  const org = String(args.org ?? ctx.config.defaultOrg ?? '').trim();
  if (org.length === 0) throw new GitHubError('org is required.', { code: 'validation' });
  if (ctx.config.allowedOrgs.length > 0 && !ctx.config.allowedOrgs.includes(org)) {
    throw new GitHubError(`Organization "${org}" is not in allowedOrgs.`, { code: 'policy' });
  }
  if (ctx.config.deniedOrgs.includes(org)) {
    throw new GitHubError(`Organization "${org}" is denied by the plugin configuration.`, { code: 'policy' });
  }
  return org;
}

function orgPath(org, suffix = '') {
  return `orgs/${encodeURIComponent(org)}${suffix}`;
}

function projectOrg(org) {
  return {
    login: org.login ?? null,
    name: org.name ?? null,
    description: org.description ?? null,
    html_url: org.html_url ?? null,
    plan: org.plan?.name ?? null,
    blog: org.blog ?? null,
    location: org.location ?? null,
    public_repos: org.public_repos ?? null,
  };
}

defineOperation({
  tool: 'github_org',
  action: 'list',
  risk: 'read',
  async prepare(ctx, args) {
    return { args };
  },
  async apply(ctx) {
    const listed = await client(ctx).apiList(ctx.config, 'user/orgs', { signal: ctx.signal });
    const items = listed.items.map(projectOrg);
    return {
      summary: `${items.length} organization${items.length === 1 ? '' : 's'}`,
      data: { kind: 'org-list', items, total: listed.complete ? items.length : null, truncated: !listed.complete },
    };
  },
});

defineOperation({
  tool: 'github_org',
  action: 'view',
  risk: 'read',
  async prepare(ctx, args) {
    return { org: orgName(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const org = await client(ctx).apiJson(ctx.config, orgPath(prepared.org), { signal: ctx.signal });
    return {
      summary: `Organization ${prepared.org}`,
      url: org?.html_url ?? null,
      data: { kind: 'org', org: projectOrg(org) },
    };
  },
});

defineOperation({
  tool: 'github_org',
  action: 'repos',
  risk: 'read',
  async prepare(ctx, args) {
    return { org: orgName(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const listed = await client(ctx).apiList(ctx.config, orgPath(prepared.org, '/repos'), { signal: ctx.signal });
    const items = listed.items.map((repo) => ({
      full_name: repo.full_name,
      name: repo.name,
      private: repo.private === true,
      default_branch: repo.default_branch,
      html_url: repo.html_url,
      archived: repo.archived === true,
    }));
    return {
      summary: `${items.length} repositor${items.length === 1 ? 'y' : 'ies'} in ${prepared.org}`,
      data: { kind: 'repo-list', items, total: listed.complete ? items.length : null, truncated: !listed.complete },
    };
  },
});

defineOperation({
  tool: 'github_org',
  action: 'members',
  risk: 'read',
  async prepare(ctx, args) {
    return { org: orgName(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const suffix = prepared.args.role ? `/members?role=${encodeURIComponent(prepared.args.role)}` : '/members';
    const listed = await client(ctx).apiList(ctx.config, orgPath(prepared.org, suffix), { signal: ctx.signal });
    const items = listed.items.map((member) => ({ login: member.login, html_url: member.html_url, id: member.id ?? null }));
    return {
      summary: `${items.length} member${items.length === 1 ? '' : 's'} in ${prepared.org}`,
      data: { kind: 'member-list', items, total: listed.complete ? items.length : null, truncated: !listed.complete },
    };
  },
});

defineOperation({
  tool: 'github_org',
  action: 'invite',
  risk: 'admin',
  async prepare(ctx, args) {
    const org = orgName(ctx, args);
    const login = String(args.login ?? '').trim();
    if (login.length === 0) throw new GitHubError('login is required.', { code: 'validation' });
    return { org, login, args };
  },
  async apply(ctx, prepared) {
    const role = prepared.args.role === 'admin' ? 'admin' : 'member';
    const membership = await client(ctx).apiJson(ctx.config, orgPath(prepared.org, `/memberships/${encodeURIComponent(prepared.login)}`), {
      method: 'PUT',
      input: { role },
      signal: ctx.signal,
    });
    return {
      summary: `Invited ${prepared.login} to ${prepared.org} as ${membership?.role ?? role}`,
      data: { kind: 'org-membership', login: prepared.login, role: membership?.role ?? role, state: membership?.state ?? null },
    };
  },
});

defineOperation({
  tool: 'github_org',
  action: 'remove',
  risk: 'admin',
  async prepare(ctx, args) {
    const org = orgName(ctx, args);
    const login = String(args.login ?? '').trim();
    if (login.length === 0) throw new GitHubError('login is required.', { code: 'validation' });
    return { org, login, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Remove ${prepared.login} from ${prepared.org}`,
      effects: [`Revoke ${prepared.login}'s organization membership`],
      confirm: `${prepared.org}:${prepared.login}`,
    };
  },
  async apply(ctx, prepared) {
    await client(ctx).apiJson(ctx.config, orgPath(prepared.org, `/memberships/${encodeURIComponent(prepared.login)}`), {
      method: 'DELETE',
      signal: ctx.signal,
    });
    return {
      summary: `Removed ${prepared.login} from ${prepared.org}`,
      data: { kind: 'org-membership', login: prepared.login, removed: true },
    };
  },
});

defineOperation({
  tool: 'github_org',
  action: 'teams',
  risk: 'read',
  async prepare(ctx, args) {
    return { org: orgName(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const listed = await client(ctx).apiList(ctx.config, orgPath(prepared.org, '/teams'), { signal: ctx.signal });
    const items = listed.items.map((team) => ({ slug: team.slug, name: team.name, description: team.description ?? null, privacy: team.privacy ?? null }));
    return {
      summary: `${items.length} team${items.length === 1 ? '' : 's'} in ${prepared.org}`,
      data: { kind: 'team-list', items, total: listed.complete ? items.length : null, truncated: !listed.complete },
    };
  },
});

defineOperation({
  tool: 'github_org',
  action: 'team',
  risk: 'read',
  async prepare(ctx, args) {
    const org = orgName(ctx, args);
    const slug = String(args.team_slug ?? '').trim();
    if (slug.length === 0) throw new GitHubError('team_slug is required.', { code: 'validation' });
    return { org, slug, args };
  },
  async apply(ctx, prepared) {
    const team = await client(ctx).apiJson(ctx.config, orgPath(prepared.org, `/teams/${encodeURIComponent(prepared.slug)}`), { signal: ctx.signal });
    return {
      summary: `Team ${prepared.org}/${prepared.slug}`,
      data: { kind: 'team', team: { slug: team?.slug, name: team?.name, description: team?.description ?? null, privacy: team?.privacy ?? null, members_count: team?.members_count ?? null } },
    };
  },
});

defineOperation({
  tool: 'github_org',
  action: 'team_create',
  risk: 'admin',
  async prepare(ctx, args) {
    const org = orgName(ctx, args);
    const name = String(args.name ?? '').trim();
    if (name.length === 0) throw new GitHubError('name is required.', { code: 'validation' });
    return { org, name, args };
  },
  async apply(ctx, prepared) {
    const team = await client(ctx).apiJson(ctx.config, orgPath(prepared.org, '/teams'), {
      method: 'POST',
      input: {
        name: prepared.name,
        description: prepared.args.description ?? undefined,
        privacy: prepared.args.privacy ?? 'closed',
        parent_team_id: Number.isInteger(prepared.args.parent_team_id) ? prepared.args.parent_team_id : undefined,
      },
      signal: ctx.signal,
    });
    return {
      summary: `Created team ${prepared.org}/${team?.slug ?? prepared.name}`,
      data: { kind: 'team', team: { slug: team?.slug, name: team?.name } },
    };
  },
});

for (const [action, method, suffix, verb] of [
  ['team_members_add', 'PUT', '/memberships', 'Added'],
  ['team_members_remove', 'DELETE', '/memberships', 'Removed'],
]) {
  defineOperation({
    tool: 'github_org',
    action,
    risk: 'admin',
    async prepare(ctx, args) {
      const org = orgName(ctx, args);
      const slug = String(args.team_slug ?? '').trim();
      const login = String(args.login ?? '').trim();
      if (slug.length === 0 || login.length === 0) throw new GitHubError('team_slug and login are required.', { code: 'validation' });
      return { org, slug, login, args };
    },
    async apply(ctx, prepared) {
      const input = method === 'PUT' ? { role: prepared.args.role === 'maintainer' ? 'maintainer' : 'member' } : undefined;
      await client(ctx).apiJson(ctx.config, orgPath(prepared.org, `/teams/${encodeURIComponent(prepared.slug)}${suffix}/${encodeURIComponent(prepared.login)}`), {
        method,
        ...(input ? { input } : {}),
        signal: ctx.signal,
      });
      return {
        summary: `${verb} ${prepared.login} ${method === 'PUT' ? 'to' : 'from'} ${prepared.org}/${prepared.slug}`,
        data: { kind: 'team-membership', team: prepared.slug, login: prepared.login, removed: method === 'DELETE' },
      };
    },
  });
}

for (const [action, method, verb] of [
  ['team_repos_add', 'PUT', 'Granted'],
  ['team_repos_remove', 'DELETE', 'Revoked'],
]) {
  defineOperation({
    tool: 'github_org',
    action,
    risk: 'admin',
    async prepare(ctx, args) {
      const org = orgName(ctx, args);
      const slug = String(args.team_slug ?? '').trim();
      const repo = String(args.repo ?? '').trim();
      if (slug.length === 0 || repo.length === 0) throw new GitHubError('team_slug and repo are required.', { code: 'validation' });
      return { org, slug, repo, args };
    },
    async apply(ctx, prepared) {
      const [owner, name] = prepared.repo.split('/');
      if (!owner || !name) throw new GitHubError('repo must be "owner/name".', { code: 'validation' });
      const permission = prepared.args.permission ?? 'pull';
      await client(ctx).apiJson(ctx.config, orgPath(prepared.org, `/teams/${encodeURIComponent(prepared.slug)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`), {
        method,
        ...(method === 'PUT' ? { input: { permission } } : {}),
        signal: ctx.signal,
      });
      return {
        summary: `${verb} ${prepared.repo} ${method === 'PUT' ? `to ${prepared.org}/${prepared.slug}` : `from ${prepared.org}/${prepared.slug}`}`,
        data: { kind: 'team-repo', team: prepared.slug, repo: prepared.repo, permission: method === 'PUT' ? permission : null },
      };
    },
  });
}

const SETTINGS_FIELDS = new Set([
  'name', 'description', 'company', 'blog', 'location', 'email', 'twitter_username',
  'members_can_create_repositories', 'members_can_create_teams', 'default_repository_permission',
]);

defineOperation({
  tool: 'github_org',
  action: 'settings_get',
  risk: 'read',
  async prepare(ctx, args) {
    return { org: orgName(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const org = await client(ctx).apiJson(ctx.config, orgPath(prepared.org), { signal: ctx.signal });
    return {
      summary: `Settings for ${prepared.org}`,
      data: { kind: 'org-settings', org: projectOrg(org), settings: Object.fromEntries([...SETTINGS_FIELDS].map((field) => [field, org?.[field] ?? null])) },
    };
  },
});

defineOperation({
  tool: 'github_org',
  action: 'settings_set',
  risk: 'admin',
  async prepare(ctx, args) {
    const org = orgName(ctx, args);
    const input = {};
    for (const field of SETTINGS_FIELDS) {
      if (args[field] !== undefined) input[field] = args[field];
    }
    if (Object.keys(input).length === 0) throw new GitHubError('settings_set needs at least one known setting.', { code: 'validation' });
    return { org, input, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Change settings for ${prepared.org}`,
      effects: Object.keys(prepared.input).map((field) => `set ${field}`),
      confirm: prepared.org,
    };
  },
  async apply(ctx, prepared) {
    const org = await client(ctx).apiJson(ctx.config, orgPath(prepared.org), {
      method: 'PATCH',
      input: prepared.input,
      signal: ctx.signal,
    });
    return {
      summary: `Updated settings for ${prepared.org}`,
      data: { kind: 'org-settings', org: projectOrg(org) },
    };
  },
});
