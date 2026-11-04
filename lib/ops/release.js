/**
 * Releases: list, view, create, edit, delete, upload, and download assets.
 * Upload/download use the authenticated `gh` command so file streaming stays out
 * of the model context.
 */

import { resolve } from 'node:path';
import { defineOperation } from './registry.js';
import { GitHubError } from '../errors.js';
import { isInside } from '../git/exec.js';

function client(ctx) {
  if (!ctx.gh) throw new GitHubError('The GitHub REST client is not available.', { code: 'unsupported' });
  return ctx.gh;
}

function repoFor(ctx, args) {
  return ctx.session.resolveRepo(args.repo, { cwd: ctx.session.cwd });
}

function repoPath(ref, suffix = '') {
  return `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}${suffix}`;
}

function projectRelease(release) {
  return {
    id: release.id ?? null,
    tag_name: release.tag_name ?? null,
    name: release.name ?? '',
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    html_url: release.html_url ?? null,
    published_at: release.published_at ?? null,
    assets: Array.isArray(release.assets)
      ? release.assets.map((asset) => ({ id: asset.id, name: asset.name, size: asset.size, download_count: asset.download_count }))
      : [],
  };
}

defineOperation({
  tool: 'github_release',
  action: 'list',
  risk: 'read',
  async prepare(ctx, args) {
    return { ref: repoFor(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const listed = await client(ctx).apiList(ctx.config, repoPath(prepared.ref, '/releases'), { signal: ctx.signal });
    const items = listed.items.map(projectRelease);
    return {
      repo: prepared.ref.full,
      summary: `${items.length} release${items.length === 1 ? '' : 's'} in ${prepared.ref.full}`,
      data: { kind: 'release-list', items, total: listed.complete ? items.length : null, truncated: !listed.complete },
    };
  },
});

defineOperation({
  tool: 'github_release',
  action: 'view',
  risk: 'read',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const id = String(args.tag ?? args.release ?? '').trim();
    if (id.length === 0) throw new GitHubError('tag or release is required.', { code: 'validation' });
    return { ref, id, args };
  },
  async apply(ctx, prepared) {
    const release = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/releases/${encodeURIComponent(prepared.id)}`), { signal: ctx.signal });
    return {
      repo: prepared.ref.full,
      summary: `Release ${release?.tag_name ?? prepared.id} in ${prepared.ref.full}`,
      url: release?.html_url ?? null,
      data: { kind: 'release', release: projectRelease(release), body: release?.body ?? null },
    };
  },
});

defineOperation({
  tool: 'github_release',
  action: 'create',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const tag = String(args.tag ?? '').trim();
    if (tag.length === 0) throw new GitHubError('tag is required.', { code: 'validation' });
    return { ref, tag, args };
  },
  async apply(ctx, prepared) {
    const release = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, '/releases'), {
      method: 'POST',
      input: {
        tag_name: prepared.tag,
        target_commitish: prepared.args.target ?? undefined,
        name: prepared.args.name ?? undefined,
        body: prepared.args.body ?? undefined,
        draft: prepared.args.draft === true,
        prerelease: prepared.args.prerelease === true,
        generate_release_notes: prepared.args.generate_release_notes === true,
      },
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Created release ${release?.tag_name ?? prepared.tag}`,
      url: release?.html_url ?? null,
      data: { kind: 'release', release: projectRelease(release) },
    };
  },
});

defineOperation({
  tool: 'github_release',
  action: 'edit',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const id = String(args.tag ?? args.release ?? '').trim();
    if (id.length === 0) throw new GitHubError('tag or release is required.', { code: 'validation' });
    return { ref, id, args };
  },
  async apply(ctx, prepared) {
    const input = {};
    for (const field of ['name', 'body', 'draft', 'prerelease']) {
      if (prepared.args[field] !== undefined) input[field] = prepared.args[field];
    }
    if (Object.keys(input).length === 0) throw new GitHubError('Nothing to edit.', { code: 'validation' });
    const release = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/releases/${encodeURIComponent(prepared.id)}`), {
      method: 'PATCH',
      input,
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Updated release ${release?.tag_name ?? prepared.id}`,
      url: release?.html_url ?? null,
      data: { kind: 'release', release: projectRelease(release) },
    };
  },
});

defineOperation({
  tool: 'github_release',
  action: 'delete',
  risk: 'destructive',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const id = String(args.tag ?? args.release ?? '').trim();
    if (id.length === 0) throw new GitHubError('tag or release is required.', { code: 'validation' });
    return { ref, id, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Delete release ${prepared.id} from ${prepared.ref.full}`,
      effects: [`Delete release ${prepared.id}`],
      confirm: `${prepared.ref.full}:${prepared.id}`,
    };
  },
  async apply(ctx, prepared) {
    await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/releases/${encodeURIComponent(prepared.id)}`), {
      method: 'DELETE',
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Deleted release ${prepared.id} from ${prepared.ref.full}`,
      data: { kind: 'release-delete', id: prepared.id },
    };
  },
});

defineOperation({
  tool: 'github_release',
  action: 'upload',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const tag = String(args.tag ?? '').trim();
    const file = String(args.file ?? '').trim();
    if (tag.length === 0 || file.length === 0) throw new GitHubError('tag and file are required.', { code: 'validation' });
    const path = resolve(ctx.session.cwd ?? process.cwd(), file);
    if (!isInside(ctx.session.cwd ?? process.cwd(), path)) throw new GitHubError('file must stay inside the session workspace.', { code: 'policy' });
    return { ref, tag, path, args };
  },
  async apply(ctx, prepared) {
    if (typeof client(ctx).command !== 'function') throw new GitHubError('Uploads need the gh command transport.', { code: 'unsupported' });
    const args = ['release', 'upload', prepared.tag, prepared.path, '--repo', prepared.ref.full];
    if (prepared.args.clobber === true) args.push('--clobber');
    await client(ctx).command(ctx.config, args, { signal: ctx.signal });
    return {
      repo: prepared.ref.full,
      summary: `Uploaded ${prepared.path} to release ${prepared.tag}`,
      data: { kind: 'release-upload', tag: prepared.tag, file: prepared.path },
    };
  },
});

defineOperation({
  tool: 'github_release',
  action: 'download',
  risk: 'local',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const tag = String(args.tag ?? '').trim();
    if (tag.length === 0) throw new GitHubError('tag is required.', { code: 'validation' });
    return { ref, tag, args };
  },
  async apply(ctx, prepared) {
    if (typeof client(ctx).command !== 'function') throw new GitHubError('Downloads need the gh command transport.', { code: 'unsupported' });
    const dir = prepared.args.dir ? resolve(ctx.session.cwd ?? process.cwd(), String(prepared.args.dir)) : (ctx.session.cwd ?? process.cwd());
    if (!isInside(ctx.session.cwd ?? process.cwd(), dir)) throw new GitHubError('dir must stay inside the session workspace.', { code: 'policy' });
    const args = ['release', 'download', prepared.tag, '--repo', prepared.ref.full, '--dir', dir];
    if (prepared.args.pattern) args.push('--pattern', String(prepared.args.pattern));
    if (prepared.args.clobber === true) args.push('--clobber');
    await client(ctx).command(ctx.config, args, { signal: ctx.signal });
    return {
      repo: prepared.ref.full,
      summary: `Downloaded release ${prepared.tag} to ${dir}`,
      data: { kind: 'release-download', tag: prepared.tag, dir },
    };
  },
});
