/**
 * Repository operations: list, view, create, edit, archive, topics, and access.
 *
 * These are remote-only. Local checkout and extraction live in the git layer and
 * in `github_extract`.
 */

import { defineOperation } from './registry.js';
import { GitHubError } from '../errors.js';
import { parseRepoRef } from '../repo.js';
import { nextStep } from '../result.js';

const VISIBILITIES = new Set(['private', 'public', 'internal']);
const PERMISSIONS = new Set(['pull', 'triage', 'push', 'maintain', 'admin']);

function client(ctx) {
  if (!ctx.gh) {
    throw new GitHubError('The GitHub REST client is not available in this operation.', {
      code: 'unsupported',
      hint: 'Mount the plugin normally; tests must pass a fake `gh` client.',
    });
  }
  return ctx.gh;
}

function repoRef(ctx, args) {
  return ctx.session.resolveRepo(args.repo, {
    fromPull: args.fromPull,
    cwd: ctx.session.cwd,
    host: args.host,
  });
}

function repoEndpoint(ref, suffix = '') {
  return `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}${suffix}`;
}

function orgEndpoint(org, suffix = '') {
  return `orgs/${encodeURIComponent(org)}${suffix}`;
}

function requireName(value) {
  if (value === undefined || value === null) throw new GitHubError('name is required.', { code: 'validation' });
  const name = String(value).trim();
  if (name.length === 0) throw new GitHubError('name is required.', { code: 'validation' });
  if (name.length > 100) throw new GitHubError('name must be at most 100 characters.', { code: 'validation' });
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new GitHubError('name may contain only letters, digits, ".", "_", and "-".', { code: 'validation' });
  }
  return name;
}

function requireOrg(ctx, args) {
  const org = String(args.org ?? ctx.config.defaultOrg ?? '').trim();
  if (org.length === 0) throw new GitHubError('org is required for an organization repository.', { code: 'validation' });
  if (ctx.config.allowedOrgs.length > 0 && !ctx.config.allowedOrgs.includes(org)) {
    throw new GitHubError(`Organization "${org}" is not in allowedOrgs.`, { code: 'policy' });
  }
  if (ctx.config.deniedOrgs.includes(org)) {
    throw new GitHubError(`Organization "${org}" is denied by the plugin configuration.`, { code: 'policy' });
  }
  return org;
}

function projectRepo(repo) {
  if (!repo || typeof repo !== 'object') return null;
  return {
    id: Number.isFinite(repo.id) ? repo.id : null,
    full_name: repo.full_name ?? null,
    name: repo.name ?? null,
    owner: repo.owner?.login ?? null,
    private: repo.private === true,
    visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
    default_branch: repo.default_branch ?? null,
    description: repo.description ?? null,
    html_url: repo.html_url ?? null,
    clone_url: repo.clone_url ?? null,
    ssh_url: repo.ssh_url ?? null,
    archived: repo.archived === true,
    fork: repo.fork === true,
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    permissions: repo.permissions ?? null,
    updated_at: repo.updated_at ?? null,
    pushed_at: repo.pushed_at ?? null,
  };
}

function repoResult(ref, repo, summary) {
  const projected = projectRepo(repo) ?? { full_name: ref.full, name: ref.name, owner: ref.owner };
  return {
    repo: projected.full_name ?? ref.full,
    url: projected.html_url ?? null,
    summary,
    data: { kind: 'repo', repo: projected },
  };
}

defineOperation({
  tool: 'github_repo',
  action: 'list',
  risk: 'read',
  async validate(args) {
    if (args.org !== undefined && args.owner !== undefined) {
      throw new GitHubError('pass either org or owner, not both.', { code: 'validation' });
    }
  },
  async prepare(ctx, args) {
    return { org: args.org ?? null, owner: args.owner ?? null, args };
  },
  async apply(ctx, prepared) {
    const { org, owner, args } = prepared;
    const endpoint = org
      ? orgEndpoint(org, '/repos')
      : (owner ? `users/${encodeURIComponent(owner)}/repos` : 'user/repos');
    const query = new URLSearchParams();
    if (args.visibility) query.set('visibility', String(args.visibility));
    if (args.type) query.set('type', String(args.type));
    if (args.sort) query.set('sort', String(args.sort));
    if (args.direction) query.set('direction', String(args.direction));
    const suffix = query.size > 0 ? `?${query}` : '';
    const listed = await client(ctx).apiList(ctx.config, `${endpoint}${suffix}`, {
      maxPages: ctx.config.maxPages,
      signal: ctx.signal,
    });
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 100;
    const items = listed.items.slice(0, limit).map(projectRepo);
    return {
      repo: org ?? owner ?? null,
      summary: `${items.length} repositor${items.length === 1 ? 'y' : 'ies'}${org ? ` in ${org}` : ''}`,
      data: { kind: 'repo-list', items, total: listed.complete ? listed.items.length : null, truncated: !listed.complete || listed.items.length > items.length },
    };
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'view',
  risk: 'read',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    return { ref, endpoint: repoEndpoint(ref), args };
  },
  async apply(ctx, prepared) {
    const repo = await client(ctx).apiJson(ctx.config, prepared.endpoint, { signal: ctx.signal });
    return repoResult(prepared.ref, repo, `Repository ${prepared.ref.full}`);
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'create',
  risk: 'write',
  async validate(args) {
    requireName(args.name);
    if (args.org !== undefined && args.owner !== undefined) {
      throw new GitHubError('pass either org or owner, not both.', { code: 'validation' });
    }
    if (args.visibility !== undefined && !VISIBILITIES.has(String(args.visibility))) {
      throw new GitHubError('visibility must be private, public, or internal.', { code: 'validation' });
    }
  },
  async prepare(ctx, args) {
    const name = String(args.name).trim();
    const org = args.org !== undefined
      ? requireOrg(ctx, args)
      : (args.owner === undefined && ctx.config.defaultOrg ? requireOrg(ctx, { ...args, org: ctx.config.defaultOrg }) : null);
    const owner = args.owner === undefined ? null : String(args.owner).trim();
    if (owner !== null && owner.length === 0) throw new GitHubError('owner must not be empty.', { code: 'validation' });
    const account = ctx.session.auth?.account ?? null;
    if (org === null && owner !== null && account !== null && owner !== account) {
      throw new GitHubError(`Repositories can be created only under the signed-in account (${account}) or an organization.`, {
        code: 'validation',
        hint: 'Pass org: "name" to create in an organization.',
      });
    }
    const visibility = args.visibility ?? 'private';
    const template = args.template === undefined ? null : parseRepoRef(String(args.template), ctx.config.defaultHost);

    let exists = false;
    const checkOwner = org ?? owner ?? ctx.session.auth?.account ?? ctx.session.defaults.owner;
    if (checkOwner) {
      try {
        await client(ctx).apiJson(ctx.config, repoEndpoint({ owner: checkOwner, name }), { signal: ctx.signal });
        exists = true;
      } catch (error) {
        if (error?.code !== 'not_found') throw error;
      }
    }
    if (exists) {
      throw new GitHubError(`Repository ${checkOwner}/${name} already exists.`, {
        code: 'conflict',
        hint: 'Use github_repo action=view to inspect it, or choose another name.',
      });
    }

    return { name, org, owner, visibility, template, args };
  },
  async plan(ctx, prepared) {
    const target = prepared.org ?? prepared.owner ?? ctx.session.auth?.account ?? 'your account';
    return {
      summary: `Create ${target}/${prepared.name} (${prepared.visibility})`,
      effects: [
        `Create repository ${target}/${prepared.name}`,
        prepared.args.auto_init === true ? 'Initialize with a README and a default branch' : 'Leave the repository empty',
        ...(Array.isArray(prepared.args.topics) && prepared.args.topics.length > 0 ? ['Set topics'] : []),
      ],
      warnings: prepared.visibility === 'public' ? ['Public repositories expose every committed file and secret scanned by GitHub.'] : [],
      confirm: null,
    };
  },
  async apply(ctx, prepared) {
    const { name, org, owner, visibility, template, args } = prepared;
    const payload = {
      name,
      private: visibility !== 'public',
      visibility,
      description: args.description ?? undefined,
      homepage: args.homepage ?? undefined,
      auto_init: args.auto_init === true,
      has_issues: args.has_issues === undefined ? undefined : args.has_issues === true,
      has_wiki: args.has_wiki === undefined ? undefined : args.has_wiki === true,
      has_projects: args.has_projects === undefined ? undefined : args.has_projects === true,
      has_discussions: args.has_discussions === undefined ? undefined : args.has_discussions === true,
      gitignore_template: args.gitignore ?? undefined,
      license_template: args.license ?? undefined,
      team_id: Number.isInteger(args.team_id) ? args.team_id : undefined,
    };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];

    let repo;
    if (template !== null) {
      const endpoint = `repos/${encodeURIComponent(template.owner)}/${encodeURIComponent(template.name)}/generate`;
      repo = await client(ctx).apiJson(ctx.config, endpoint, {
        method: 'POST',
        input: {
          owner: org ?? owner ?? ctx.session.auth?.account,
          name,
          description: payload.description,
          private: payload.private,
          include_all_branches: args.include_all_branches === true,
        },
        signal: ctx.signal,
      });
    } else {
      const endpoint = org ? orgEndpoint(org, '/repos') : 'user/repos';
      repo = await client(ctx).apiJson(ctx.config, endpoint, {
        method: 'POST',
        input: payload,
        signal: ctx.signal,
      });
    }

    if (!repo?.full_name) {
      throw new GitHubError('GitHub accepted the request but returned no repository.', {
        code: 'partial',
        hint: 'Check github_repo action=list before retrying.',
      });
    }

    if (Array.isArray(args.topics) && args.topics.length > 0) {
      await client(ctx).apiJson(ctx.config, repoEndpoint({ owner: repo.owner?.login ?? org ?? owner, name: repo.name ?? name }, '/topics'), {
        method: 'PUT',
        input: { names: args.topics.map(String) },
        signal: ctx.signal,
      });
    }

    const projected = projectRepo(repo);
    return {
      ...repoResult({ owner: repo.owner?.login ?? org ?? owner, name: repo.name ?? name, full: repo.full_name }, repo, `Created ${repo.full_name}`),
      next: [nextStep('github_workspace', { action: 'clone', repo: repo.full_name }, 'clone the new repository')],
    };
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'edit',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    return { ref, endpoint: repoEndpoint(ref), args };
  },
  async plan(ctx, prepared) {
    const fields = ['description', 'homepage', 'topics', 'visibility', 'archived', 'default_branch', 'has_issues', 'has_wiki', 'has_projects', 'has_discussions'];
    const changes = fields.filter((field) => prepared.args[field] !== undefined);
    return {
      summary: `Edit ${prepared.ref.full}`,
      effects: changes.length > 0 ? changes.map((field) => `set ${field}`) : ['no fields changed'],
      risk: prepared.args.visibility === 'public' ? 'admin' : 'write',
      confirm: prepared.args.visibility === 'public' ? prepared.ref.full : null,
      warnings: prepared.args.visibility === 'public' ? ['Changing a repository to public exposes its contents.'] : [],
    };
  },
  async apply(ctx, prepared) {
    const { ref, endpoint, args } = prepared;
    const payload = {};
    for (const field of ['description', 'homepage', 'default_branch', 'visibility', 'archived']) {
      if (args[field] !== undefined) payload[field] = args[field];
    }
    if (args.has_issues !== undefined) payload.has_issues = args.has_issues === true;
    if (args.has_wiki !== undefined) payload.has_wiki = args.has_wiki === true;
    if (args.has_projects !== undefined) payload.has_projects = args.has_projects === true;
    if (args.has_discussions !== undefined) payload.has_discussions = args.has_discussions === true;
    if (Object.keys(payload).length === 0) {
      throw new GitHubError('Nothing to edit: provide at least one field.', { code: 'validation' });
    }
    const repo = await client(ctx).apiJson(ctx.config, endpoint, {
      method: 'PATCH',
      input: payload,
      signal: ctx.signal,
    });
    if (Array.isArray(args.topics)) {
      await client(ctx).apiJson(ctx.config, repoEndpoint(ref, '/topics'), {
        method: 'PUT',
        input: { names: args.topics.map(String) },
        signal: ctx.signal,
      });
    }
    return repoResult(ref, repo, `Updated ${ref.full}`);
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'archive',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    return { ref, endpoint: repoEndpoint(ref), args };
  },
  async apply(ctx, prepared) {
    const repo = await client(ctx).apiJson(ctx.config, prepared.endpoint, {
      method: 'PATCH',
      input: { archived: true },
      signal: ctx.signal,
    });
    return repoResult(prepared.ref, repo, `Archived ${prepared.ref.full}`);
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'unarchive',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    return { ref, endpoint: repoEndpoint(ref), args };
  },
  async apply(ctx, prepared) {
    const repo = await client(ctx).apiJson(ctx.config, prepared.endpoint, {
      method: 'PATCH',
      input: { archived: false },
      signal: ctx.signal,
    });
    return repoResult(prepared.ref, repo, `Unarchived ${prepared.ref.full}`);
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'topics',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    if (!Array.isArray(args.topics)) throw new GitHubError('topics must be an array of strings.', { code: 'validation' });
    return { ref, endpoint: repoEndpoint(ref, '/topics'), args };
  },
  async apply(ctx, prepared) {
    const topics = prepared.args.topics.map(String);
    await client(ctx).apiJson(ctx.config, prepared.endpoint, {
      method: 'PUT',
      input: { names: topics },
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Set ${topics.length} topic${topics.length === 1 ? '' : 's'} on ${prepared.ref.full}`,
      data: { kind: 'topics', topics },
    };
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'access_list',
  risk: 'read',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    return { ref, endpoint: repoEndpoint(ref, '/collaborators'), args };
  },
  async apply(ctx, prepared) {
    const listed = await client(ctx).apiList(ctx.config, prepared.endpoint, { signal: ctx.signal });
    const items = listed.items.map((entry) => ({
      login: entry.login ?? null,
      id: Number.isFinite(entry.id) ? entry.id : null,
      permissions: entry.permissions ?? null,
      role_name: entry.role_name ?? null,
      html_url: entry.html_url ?? null,
    }));
    return {
      repo: prepared.ref.full,
      summary: `${items.length} collaborator${items.length === 1 ? '' : 's'} on ${prepared.ref.full}`,
      data: { kind: 'access-list', items, total: listed.complete ? items.length : null, truncated: !listed.complete },
    };
  },
});

async function changeAccess(ctx, prepared, permission) {
  const user = String(prepared.args.user ?? '').trim();
  if (user.length === 0) throw new GitHubError('user is required.', { code: 'validation' });
  if (!PERMISSIONS.has(permission)) {
    throw new GitHubError(`permission must be one of ${[...PERMISSIONS].join(', ')}.`, { code: 'validation' });
  }
  await client(ctx).apiJson(ctx.config, repoEndpoint(prepared.ref, `/collaborators/${encodeURIComponent(user)}`), {
    method: 'PUT',
    input: { permission },
    signal: ctx.signal,
  });
  return {
    repo: prepared.ref.full,
    summary: `Gave ${user} ${permission} access to ${prepared.ref.full}`,
    data: { kind: 'access', user, permission },
  };
}

defineOperation({
  tool: 'github_repo',
  action: 'access_add',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    return { ref, args };
  },
  async apply(ctx, prepared) {
    return changeAccess(ctx, prepared, String(prepared.args.permission ?? 'push'));
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'access_set',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    return { ref, args };
  },
  async apply(ctx, prepared) {
    return changeAccess(ctx, prepared, String(prepared.args.permission ?? 'push'));
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'transfer',
  risk: 'destructive',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    const newOwner = String(args.new_owner ?? '').trim();
    if (newOwner.length === 0) throw new GitHubError('new_owner is required.', { code: 'validation' });
    if (ctx.config.allowedOrgs.length > 0 && !ctx.config.allowedOrgs.includes(newOwner)) {
      throw new GitHubError(`Organization "${newOwner}" is not in allowedOrgs.`, { code: 'policy' });
    }
    if (ctx.config.deniedOrgs.includes(newOwner)) {
      throw new GitHubError(`Organization "${newOwner}" is denied by the plugin configuration.`, { code: 'policy' });
    }
    const repo = await client(ctx).apiJson(ctx.config, repoEndpoint(ref), { signal: ctx.signal });
    return { ref, newOwner, current: projectRepo(repo), args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Transfer ${prepared.ref.full} to ${prepared.newOwner}`,
      effects: [
        `Change repository owner to ${prepared.newOwner}`,
        'Old URLs redirect; local remotes must be updated',
        'Verify Actions secrets/variables, packages, Pages, webhooks, and team access after the transfer',
      ],
      confirm: `${prepared.ref.full} -> ${prepared.newOwner}`,
      warnings: ['Some integrations are not transferred automatically; use the post-transfer checklist.'],
    };
  },
  async apply(ctx, prepared) {
    const teamIds = Array.isArray(prepared.args.team_ids)
      ? prepared.args.team_ids.filter((id) => Number.isInteger(id))
      : undefined;
    await client(ctx).apiJson(ctx.config, repoEndpoint(prepared.ref, '/transfer'), {
      method: 'POST',
      input: { new_owner: prepared.newOwner, ...(teamIds && teamIds.length > 0 ? { team_ids: teamIds } : {}) },
      signal: ctx.signal,
    });
    const renamed = { ...prepared.ref, owner: prepared.newOwner, full: `${prepared.newOwner}/${prepared.ref.name}` };
    for (const [path, binding] of ctx.session.bindings) {
      if (binding.repo === prepared.ref.full) ctx.session.bindings.set(path, { ...binding, repo: renamed.full, host: renamed.host });
    }
    return {
      repo: renamed.full,
      summary: `Transferred ${prepared.ref.full} to ${prepared.newOwner}`,
      data: { kind: 'repo-transfer', from: prepared.ref.full, to: renamed.full },
      next: [nextStep('github_repo', { action: 'view', repo: renamed.full }, 'verify the transferred repository')],
    };
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'rename',
  risk: 'destructive',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    const newName = requireName(args.new_name);
    return { ref, newName, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Rename ${prepared.ref.full} to ${prepared.newName}`,
      effects: [`Rename the repository to ${prepared.newName}`, 'Old URLs redirect; local remotes should be updated'],
      confirm: `${prepared.ref.full} -> ${prepared.ref.owner}/${prepared.newName}`,
    };
  },
  async apply(ctx, prepared) {
    const repo = await client(ctx).apiJson(ctx.config, repoEndpoint(prepared.ref), {
      method: 'PATCH',
      input: { name: prepared.newName },
      signal: ctx.signal,
    });
    const renamed = { ...prepared.ref, name: prepared.newName, full: `${prepared.ref.owner}/${prepared.newName}` };
    for (const [path, binding] of ctx.session.bindings) {
      if (binding.repo === prepared.ref.full) ctx.session.bindings.set(path, { ...binding, repo: renamed.full });
    }
    return repoResult(renamed, repo, `Renamed ${prepared.ref.full} to ${renamed.full}`);
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'delete',
  risk: 'destructive',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    return { ref, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Delete ${prepared.ref.full}`,
      effects: ['Delete the repository and its issues, pull requests, and actions data', 'This cannot be undone'],
      irreversible: true,
      confirm: `DELETE ${prepared.ref.full}`,
      warnings: ['Consider archiving the repository instead of deleting it.'],
    };
  },
  async apply(ctx, prepared) {
    await client(ctx).apiJson(ctx.config, repoEndpoint(prepared.ref), { method: 'DELETE', signal: ctx.signal });
    for (const [path, binding] of ctx.session.bindings) {
      if (binding.repo === prepared.ref.full) ctx.session.bindings.delete(path);
    }
    return {
      repo: prepared.ref.full,
      summary: `Deleted ${prepared.ref.full}`,
      data: { kind: 'repo-delete', repo: prepared.ref.full },
    };
  },
});

defineOperation({
  tool: 'github_repo',
  action: 'access_remove',
  risk: 'destructive',
  async prepare(ctx, args) {
    const ref = repoRef(ctx, args);
    const user = String(args.user ?? '').trim();
    if (user.length === 0) throw new GitHubError('user is required.', { code: 'validation' });
    return { ref, user, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Remove ${prepared.user} from ${prepared.ref.full}`,
      effects: [`Revoke ${prepared.user}'s collaborator access`],
      confirm: `${prepared.ref.full}:${prepared.user}`,
    };
  },
  async apply(ctx, prepared) {
    await client(ctx).apiJson(ctx.config, repoEndpoint(prepared.ref, `/collaborators/${encodeURIComponent(prepared.user)}`), {
      method: 'DELETE',
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Removed ${prepared.user} from ${prepared.ref.full}`,
      data: { kind: 'access', user: prepared.user, removed: true },
    };
  },
});
