/**
 * Branch and tag operations. Branch creation is the missing link between a file
 * write and a pull request: protected default branches stay untouched.
 */

import { defineOperation } from './registry.js';
import { GitHubError } from '../errors.js';

function client(ctx) {
  if (!ctx.gh) throw new GitHubError('The GitHub REST client is not available.', { code: 'unsupported' });
  return ctx.gh;
}

function repoEndpoint(ref, suffix = '') {
  return `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}${suffix}`;
}

function validateRefName(value) {
  const name = String(value ?? '').trim();
  if (name.length === 0) throw new GitHubError('ref is required.', { code: 'validation' });
  if (name.startsWith('-') || /[\s~^:?*[\\]/.test(name) || name.includes('..') || name.endsWith('.lock')) {
    throw new GitHubError(`"${name}" is not a valid branch or tag name.`, { code: 'validation' });
  }
  return name;
}

async function resolveSha(ctx, ref, from) {
  const value = String(from ?? '').trim();
  if (/^[0-9a-f]{40}$/i.test(value)) return value;
  if (value.length === 0) {
    const repo = await client(ctx).apiJson(ctx.config, repoEndpoint(ref), { signal: ctx.signal });
    const branch = repo?.default_branch;
    if (!branch) throw new GitHubError(`Could not resolve the default branch of ${ref.full}.`, { code: 'unknown' });
    return resolveSha(ctx, ref, branch);
  }
  try {
    const found = await client(ctx).apiJson(ctx.config, repoEndpoint(ref, `/git/ref/heads/${encodeURIComponent(value)}`), {
      signal: ctx.signal,
    });
    if (found?.object?.sha) return found.object.sha;
  } catch (error) {
    if (error?.code !== 'not_found') throw error;
  }
  const commit = await client(ctx).apiJson(ctx.config, repoEndpoint(ref, `/commits/${encodeURIComponent(value)}`), {
    signal: ctx.signal,
  });
  if (!commit?.sha) throw new GitHubError(`Could not resolve "${value}" to a commit.`, { code: 'not_found' });
  return commit.sha;
}

defineOperation({
  tool: 'github_ref',
  action: 'list',
  risk: 'read',
  async prepare(ctx, args) {
    const ref = ctx.session.resolveRepo(args.repo, { cwd: ctx.session.cwd });
    const kind = args.kind === 'tag' ? 'tag' : 'branch';
    return { ref, kind, endpoint: repoEndpoint(ref, kind === 'tag' ? '/tags' : '/branches'), args };
  },
  async apply(ctx, prepared) {
    const listed = await client(ctx).apiList(ctx.config, prepared.endpoint, { signal: ctx.signal });
    const items = listed.items.map((entry) => ({
      name: entry.name,
      sha: entry.commit?.sha ?? entry.sha ?? null,
      protected: entry.protected === true,
    }));
    return {
      repo: prepared.ref.full,
      summary: `${items.length} ${prepared.kind}${items.length === 1 ? '' : 's'} in ${prepared.ref.full}`,
      data: { kind: `${prepared.kind}-list`, items, total: listed.complete ? items.length : null, truncated: !listed.complete },
    };
  },
});

defineOperation({
  tool: 'github_ref',
  action: 'view',
  risk: 'read',
  async prepare(ctx, args) {
    const ref = ctx.session.resolveRepo(args.repo, { cwd: ctx.session.cwd });
    const name = validateRefName(args.ref);
    return { ref, name, endpoint: repoEndpoint(ref, `/branches/${encodeURIComponent(name)}`), args };
  },
  async apply(ctx, prepared) {
    const branch = await client(ctx).apiJson(ctx.config, prepared.endpoint, { signal: ctx.signal });
    return {
      repo: prepared.ref.full,
      summary: `Branch ${prepared.name} in ${prepared.ref.full}`,
      data: {
        kind: 'branch',
        name: branch.name ?? prepared.name,
        sha: branch.commit?.sha ?? null,
        protected: branch.protected === true,
        protection: branch.protection ?? null,
      },
    };
  },
});

defineOperation({
  tool: 'github_ref',
  action: 'create',
  risk: 'write',
  async validate(args) {
    validateRefName(args.ref);
  },
  async prepare(ctx, args) {
    const ref = ctx.session.resolveRepo(args.repo, { cwd: ctx.session.cwd });
    const name = validateRefName(args.ref);
    const kind = args.kind === 'tag' ? 'tag' : 'branch';
    const sha = await resolveSha(ctx, ref, args.from);
    return { ref, name, kind, sha, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Create ${prepared.kind} ${prepared.name} at ${prepared.sha.slice(0, 7)}`,
      effects: [`Add refs/${prepared.kind === 'tag' ? 'tags' : 'heads'}/${prepared.name}`],
      api: [{ method: 'POST', path: `/repos/${prepared.ref.owner}/${prepared.ref.name}/git/refs` }],
    };
  },
  async apply(ctx, prepared) {
    const refName = `refs/${prepared.kind === 'tag' ? 'tags' : 'heads'}/${prepared.name}`;
    const created = await client(ctx).apiJson(ctx.config, repoEndpoint(prepared.ref, '/git/refs'), {
      method: 'POST',
      input: { ref: refName, sha: prepared.sha },
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Created ${prepared.kind} ${prepared.name} in ${prepared.ref.full}`,
      data: {
        kind: prepared.kind,
        name: prepared.name,
        ref: created?.ref ?? refName,
        sha: created?.object?.sha ?? prepared.sha,
      },
    };
  },
});

defineOperation({
  tool: 'github_ref',
  action: 'delete',
  risk: 'destructive',
  async prepare(ctx, args) {
    const ref = ctx.session.resolveRepo(args.repo, { cwd: ctx.session.cwd });
    const name = validateRefName(args.ref);
    const branch = await client(ctx).apiJson(ctx.config, repoEndpoint(ref, `/branches/${encodeURIComponent(name)}`), {
      signal: ctx.signal,
    });
    const repo = await client(ctx).apiJson(ctx.config, repoEndpoint(ref), { signal: ctx.signal });
    if (repo?.default_branch === name) {
      throw new GitHubError(`Refusing to delete the default branch "${name}".`, { code: 'policy' });
    }
    if (branch?.protected === true && args.allow_protected !== true) {
      throw new GitHubError(`Branch "${name}" is protected; pass allow_protected: true to delete it.`, {
        code: 'policy',
      });
    }
    return { ref, name, protected: branch?.protected === true, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Delete branch ${prepared.name} in ${prepared.ref.full}`,
      effects: [`Remove refs/heads/${prepared.name}`],
      confirm: `${prepared.ref.full}:${prepared.name}`,
      warnings: prepared.protected ? ['This branch is protected.'] : [],
    };
  },
  async apply(ctx, prepared) {
    await client(ctx).apiJson(ctx.config, repoEndpoint(prepared.ref, `/git/refs/heads/${encodeURIComponent(prepared.name)}`), {
      method: 'DELETE',
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Deleted branch ${prepared.name} in ${prepared.ref.full}`,
      data: { kind: 'branch-delete', name: prepared.name },
    };
  },
});
