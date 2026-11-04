/**
 * File operations that write through the Contents API.
 *
 * A single-file write is one Contents API call with an explicit `sha` for
 * optimistic concurrency. Deletion is the same endpoint with DELETE. Multi-file
 * atomic commits and moves arrive with the Git Data API in a later phase.
 */

import { defineOperation } from './registry.js';
import { GitHubError } from '../errors.js';
import { nextStep } from '../result.js';

function client(ctx) {
  if (!ctx.gh) {
    throw new GitHubError('The GitHub REST client is not available in this operation.', {
      code: 'unsupported',
      hint: 'Mount the plugin normally; tests must pass a fake `gh` client.',
    });
  }
  return ctx.gh;
}

function normalizePath(input) {
  const raw = String(input ?? '').trim().replace(/\\/g, '/');
  const value = raw.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (value.length === 0) throw new GitHubError('path is required.', { code: 'validation' });
  if (value.split('/').some((segment) => segment === '..' || segment.length === 0)) {
    throw new GitHubError(`path must stay inside the repository: "${raw}".`, { code: 'validation' });
  }
  return value;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function repoEndpoint(ref, suffix = '') {
  return `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}${suffix}`;
}

function contentEndpoint(ref, path, suffix = '') {
  return repoEndpoint(ref, `/contents/${encodePath(path)}${suffix}`);
}

function isProtected(config, branch) {
  if (typeof branch !== 'string') return false;
  return config.protectedBranches.some((pattern) => {
    if (pattern.includes('*')) {
      const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return new RegExp(`^${escaped}$`).test(branch);
    }
    return pattern === branch;
  });
}

async function defaultBranch(ctx, ref) {
  const repo = await client(ctx).apiJson(ctx.config, repoEndpoint(ref), { signal: ctx.signal });
  const branch = repo?.default_branch;
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new GitHubError(`Could not resolve the default branch of ${ref.full}.`, { code: 'unknown' });
  }
  return branch;
}

async function currentFile(ctx, ref, path, branch) {
  try {
    return await client(ctx).apiJson(ctx.config, contentEndpoint(ref, path, `?ref=${encodeURIComponent(branch)}`), {
      signal: ctx.signal,
    });
  } catch (error) {
    if (error?.code === 'not_found') return null;
    throw error;
  }
}

function ensureNotProtected(ctx, branch, args = {}) {
  if (isProtected(ctx.config, branch) && args.allow_protected !== true) {
    throw new GitHubError(
      `Direct writes to protected branch "${branch}" are disabled.`,
      {
        code: 'policy',
        hint: 'Create a feature branch and open a pull request, or pass allow_protected: true with an explicit approval.',
      },
    );
  }
}

defineOperation({
  tool: 'github_file',
  action: 'stat',
  risk: 'read',
  async prepare(ctx, args) {
    const ref = ctx.session.resolveRepo(args.repo, { fromPull: args.fromPull, cwd: ctx.session.cwd });
    const path = normalizePath(args.path);
    const branch = args.ref ?? args.branch ?? null;
    return { ref, path, branch, args };
  },
  async apply(ctx, prepared) {
    const suffix = prepared.branch ? `?ref=${encodeURIComponent(prepared.branch)}` : '';
    const data = await client(ctx).apiJson(ctx.config, contentEndpoint(prepared.ref, prepared.path, suffix), {
      signal: ctx.signal,
    });
    if (Array.isArray(data)) {
      return {
        repo: prepared.ref.full,
        summary: `${prepared.path} is a directory with ${data.length} entries`,
        data: {
          kind: 'directory',
          path: prepared.path,
          entries: data.map((entry) => ({ name: entry.name, type: entry.type, size: entry.size ?? null, sha: entry.sha ?? null })),
        },
      };
    }
    if (!data || typeof data !== 'object') {
      throw new GitHubError(`No content found at "${prepared.path}" in ${prepared.ref.full}.`, { code: 'not_found' });
    }
    return {
      repo: prepared.ref.full,
      summary: `${prepared.path} is a ${data.type ?? 'file'} (${data.size ?? 0} bytes)`,
      data: {
        kind: 'file-stat',
        path: data.path ?? prepared.path,
        type: data.type ?? 'file',
        size: Number.isFinite(data.size) ? data.size : null,
        sha: data.sha ?? null,
        html_url: data.html_url ?? null,
      },
    };
  },
});

defineOperation({
  tool: 'github_file',
  action: 'write',
  risk: 'write',
  async validate(args) {
    if (typeof args.content !== 'string') throw new GitHubError('content must be a string.', { code: 'validation' });
    if (typeof args.message !== 'string' || args.message.trim().length === 0) {
      throw new GitHubError('message is required for a file write.', { code: 'validation' });
    }
  },
  async prepare(ctx, args) {
    const ref = ctx.session.resolveRepo(args.repo, { fromPull: args.fromPull, cwd: ctx.session.cwd });
    const path = normalizePath(args.path);
    const branch = typeof args.branch === 'string' && args.branch.trim().length > 0
      ? args.branch.trim()
      : await defaultBranch(ctx, ref);
    const protectedBranch = isProtected(ctx.config, branch);
    const existing = await currentFile(ctx, ref, path, branch);

    if (existing !== null && Array.isArray(existing)) {
      throw new GitHubError(`"${path}" is a directory; file writes need a file path.`, { code: 'validation' });
    }
    if (existing !== null && typeof args.sha === 'string' && args.sha !== existing.sha) {
      throw new GitHubError(`"${path}" changed since sha ${args.sha} was read; current sha is ${existing.sha}.`, {
        code: 'conflict',
        hint: 'Re-read the file and retry with the current sha.',
      });
    }
    if (existing !== null && typeof args.sha !== 'string') {
      throw new GitHubError(`"${path}" already exists; pass its current sha to overwrite it.`, {
        code: 'conflict',
        hint: `Current sha is ${existing.sha}. Re-read the file and pass sha explicitly.`,
      });
    }
    if (existing === null && typeof args.sha === 'string') {
      throw new GitHubError(`"${path}" does not exist on ${branch}; omit sha to create it.`, { code: 'conflict' });
    }

    const bytes = args.encoding === 'base64'
      ? Buffer.byteLength(args.content, 'base64')
      : Buffer.byteLength(args.content, 'utf8');
    if (bytes > ctx.config.maxWriteBytes) {
      throw new GitHubError(`content is ${bytes} bytes; the configured limit is ${ctx.config.maxWriteBytes}.`, {
        code: 'validation',
        hint: 'Use a larger maxWriteBytes, or commit through a local clone.',
      });
    }

    return { ref, path, branch, existing, bytes, protectedBranch, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `${prepared.existing ? 'Update' : 'Create'} ${prepared.path} on ${prepared.branch}`,
      effects: [
        `${prepared.existing ? 'Replace' : 'Add'} ${prepared.path}`,
        `Commit: ${prepared.args.message}`,
      ],
      api: [{
        method: 'PUT',
        path: `/repos/${prepared.ref.owner}/${prepared.ref.name}/contents/${prepared.path}`,
      }],
      warnings: prepared.protectedBranch ? [`Branch ${prepared.branch} matches protectedBranches.`] : [],
    };
  },
  async apply(ctx, prepared) {
    ensureNotProtected(ctx, prepared.branch, prepared.args);
    const { ref, path, branch, existing, args } = prepared;
    const content = args.encoding === 'base64'
      ? args.content
      : Buffer.from(args.content, 'utf8').toString('base64');
    const input = {
      message: args.message.trim(),
      content,
      branch,
      ...(existing !== null ? { sha: existing.sha } : {}),
    };
    const result = await client(ctx).apiJson(ctx.config, contentEndpoint(ref, path), {
      method: 'PUT',
      input,
      signal: ctx.signal,
    });
    const commitSha = result?.commit?.sha ?? null;
    return {
      repo: ref.full,
      summary: `${existing ? 'Updated' : 'Created'} ${path} on ${branch}`,
      url: result?.content?.html_url ?? null,
      data: {
        kind: 'file-write',
        path,
        branch,
        commit: commitSha,
        sha: result?.content?.sha ?? null,
        created: existing === null,
      },
      next: commitSha
        ? [nextStep('github_file', { action: 'stat', repo: ref.full, path, ref: branch }, 'verify the new file state')]
        : [],
    };
  },
});

defineOperation({
  tool: 'github_file',
  action: 'delete',
  risk: 'write',
  async validate(args) {
    if (typeof args.message !== 'string' || args.message.trim().length === 0) {
      throw new GitHubError('message is required for a file delete.', { code: 'validation' });
    }
  },
  async prepare(ctx, args) {
    const ref = ctx.session.resolveRepo(args.repo, { fromPull: args.fromPull, cwd: ctx.session.cwd });
    const path = normalizePath(args.path);
    const branch = typeof args.branch === 'string' && args.branch.trim().length > 0
      ? args.branch.trim()
      : await defaultBranch(ctx, ref);
    const existing = await currentFile(ctx, ref, path, branch);
    if (existing === null) {
      throw new GitHubError(`"${path}" does not exist on ${branch}.`, { code: 'not_found' });
    }
    if (Array.isArray(existing)) {
      throw new GitHubError(`"${path}" is a directory; delete files individually.`, { code: 'validation' });
    }
    if (typeof args.sha === 'string' && args.sha !== existing.sha) {
      throw new GitHubError(`"${path}" changed since sha ${args.sha} was read; current sha is ${existing.sha}.`, {
        code: 'conflict',
      });
    }
    return { ref, path, branch, existing, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Delete ${prepared.path} on ${prepared.branch}`,
      effects: [`Remove ${prepared.path}`, `Commit: ${prepared.args.message}`],
      warnings: isProtected(ctx.config, prepared.branch) ? [`Branch ${prepared.branch} is protected.`] : [],
    };
  },
  async apply(ctx, prepared) {
    ensureNotProtected(ctx, prepared.branch, prepared.args);
    const { ref, path, branch, existing, args } = prepared;
    const result = await client(ctx).apiJson(ctx.config, contentEndpoint(ref, path), {
      method: 'DELETE',
      input: { message: args.message.trim(), sha: existing.sha, branch },
      signal: ctx.signal,
    });
    return {
      repo: ref.full,
      summary: `Deleted ${path} on ${branch}`,
      data: { kind: 'file-delete', path, branch, commit: result?.commit?.sha ?? null },
    };
  },
});

/* ------------------------------------------------------------------------- */
/* Git Data API: atomic multi-file commit, move, and copy                     */
/* ------------------------------------------------------------------------- */

async function gitRef(ctx, ref, branch) {
  const data = await client(ctx).apiJson(ctx.config, repoEndpoint(ref, `/git/ref/heads/${encodeURIComponent(branch)}`), {
    signal: ctx.signal,
  });
  const sha = data?.object?.sha;
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new GitHubError(`Could not resolve branch ${branch} in ${ref.full}.`, { code: 'not_found' });
  }
  return sha;
}

async function commitTree(ctx, ref, sha) {
  const commit = await client(ctx).apiJson(ctx.config, repoEndpoint(ref, `/git/commits/${sha}`), { signal: ctx.signal });
  const tree = commit?.tree?.sha;
  if (typeof tree !== 'string' || tree.length === 0) {
    throw new GitHubError(`Could not resolve the tree of commit ${sha}.`, { code: 'unknown' });
  }
  return tree;
}

async function sourceBlob(ctx, ref, path, branch) {
  const data = await currentFile(ctx, ref, path, branch);
  if (data === null) throw new GitHubError(`"${path}" does not exist on ${branch}.`, { code: 'not_found' });
  if (Array.isArray(data)) throw new GitHubError(`"${path}" is a directory.`, { code: 'validation' });
  if (typeof data.sha !== 'string') throw new GitHubError(`Could not resolve the blob sha of "${path}".`, { code: 'unknown' });
  return {
    sha: data.sha,
    mode: data.type === 'symlink' ? '120000' : '100644',
    path,
  };
}

async function createBlob(ctx, ref, content, encoding) {
  const base64 = encoding === 'base64' ? content : Buffer.from(content, 'utf8').toString('base64');
  if (Buffer.byteLength(base64, 'base64') > ctx.config.maxWriteBytes) {
    throw new GitHubError('File content exceeds maxWriteBytes.', { code: 'validation' });
  }
  const blob = await client(ctx).apiJson(ctx.config, repoEndpoint(ref, '/git/blobs'), {
    method: 'POST',
    input: { content: base64, encoding: 'base64' },
    signal: ctx.signal,
  });
  if (typeof blob?.sha !== 'string') throw new GitHubError('GitHub returned no blob sha.', { code: 'unknown' });
  return blob.sha;
}

function normalizeChange(change, index) {
  const label = `changes[${index}]`;
  if (change === null || typeof change !== 'object') throw new GitHubError(`${label} must be an object.`, { code: 'validation' });
  const op = String(change.op ?? '').trim();
  if (!['write', 'delete', 'move', 'copy'].includes(op)) {
    throw new GitHubError(`${label}.op must be write, delete, move, or copy.`, { code: 'validation' });
  }
  if (op === 'write') {
    if (typeof change.path !== 'string') throw new GitHubError(`${label}.path is required.`, { code: 'validation' });
    if (typeof change.content !== 'string') throw new GitHubError(`${label}.content must be a string.`, { code: 'validation' });
    return { op, path: normalizePath(change.path), content: change.content, encoding: change.encoding ?? 'utf8', mode: change.mode ?? '100644' };
  }
  if (op === 'delete') {
    if (typeof change.path !== 'string') throw new GitHubError(`${label}.path is required.`, { code: 'validation' });
    return { op, path: normalizePath(change.path) };
  }
  if (typeof change.from !== 'string' || typeof change.to !== 'string') {
    throw new GitHubError(`${label}.from and ${label}.to are required.`, { code: 'validation' });
  }
  return {
    op,
    from: normalizePath(change.from),
    to: normalizePath(change.to),
    overwrite: change.overwrite === true,
  };
}

async function prepareCommit(ctx, args) {
  const ref = ctx.session.resolveRepo(args.repo, { fromPull: args.fromPull, cwd: ctx.session.cwd });
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (message.length === 0) throw new GitHubError('message is required.', { code: 'validation' });
  const branch = typeof args.branch === 'string' && args.branch.trim().length > 0
    ? args.branch.trim()
    : await defaultBranch(ctx, ref);
  const rawChanges = Array.isArray(args.changes) ? args.changes : [];
  if (rawChanges.length === 0) throw new GitHubError('changes must contain at least one operation.', { code: 'validation' });
  const changes = rawChanges.map((change, index) => normalizeChange(change, index));

  const head = typeof args.base_sha === 'string' && args.base_sha.trim().length > 0
    ? args.base_sha.trim()
    : await gitRef(ctx, ref, branch);
  if (typeof args.base_sha === 'string' && args.base_sha.trim().length > 0) {
    const current = await gitRef(ctx, ref, branch);
    if (current !== args.base_sha.trim()) {
      throw new GitHubError(`Branch ${branch} moved since base_sha ${args.base_sha}; current head is ${current}.`, { code: 'conflict' });
    }
  }
  const tree = await commitTree(ctx, ref, head);

  const preparedChanges = [];
  for (const change of changes) {
    if (change.op === 'write') {
      const existing = await currentFile(ctx, ref, change.path, branch);
      if (existing !== null && Array.isArray(existing)) {
        throw new GitHubError(`"${change.path}" is a directory.`, { code: 'validation' });
      }
      preparedChanges.push(change);
      continue;
    }
    if (change.op === 'delete') {
      const existing = await currentFile(ctx, ref, change.path, branch);
      if (existing === null) throw new GitHubError(`"${change.path}" does not exist on ${branch}.`, { code: 'not_found' });
      preparedChanges.push(change);
      continue;
    }
    const source = await sourceBlob(ctx, ref, change.from, branch);
    const existing = await currentFile(ctx, ref, change.to, branch);
    if (existing !== null && change.overwrite !== true) {
      throw new GitHubError(`"${change.to}" already exists; pass overwrite: true to replace it.`, { code: 'conflict' });
    }
    preparedChanges.push({ ...change, source });
  }

  return { ref, branch, head, tree, message, changes: preparedChanges, args };
}

async function applyCommit(ctx, prepared) {
  ensureNotProtected(ctx, prepared.branch, prepared.args);
  const treeEntries = [];
  for (const change of prepared.changes) {
    if (change.op === 'write') {
      const sha = await createBlob(ctx, prepared.ref, change.content, change.encoding);
      treeEntries.push({ path: change.path, mode: change.mode, type: 'blob', sha });
    } else if (change.op === 'delete') {
      treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
    } else {
      treeEntries.push({ path: change.to, mode: change.source.mode, type: 'blob', sha: change.source.sha });
      if (change.op === 'move') treeEntries.push({ path: change.from, mode: '100644', type: 'blob', sha: null });
    }
  }

  const newTree = await client(ctx).apiJson(ctx.config, repoEndpoint(prepared.ref, '/git/trees'), {
    method: 'POST',
    input: { base_tree: prepared.tree, tree: treeEntries },
    signal: ctx.signal,
  });
  if (typeof newTree?.sha !== 'string') throw new GitHubError('GitHub returned no tree sha.', { code: 'unknown' });

  const commit = await client(ctx).apiJson(ctx.config, repoEndpoint(prepared.ref, '/git/commits'), {
    method: 'POST',
    input: { message: prepared.message, tree: newTree.sha, parents: [prepared.head] },
    signal: ctx.signal,
  });
  if (typeof commit?.sha !== 'string') throw new GitHubError('GitHub returned no commit sha.', { code: 'unknown' });

  await client(ctx).apiJson(ctx.config, repoEndpoint(prepared.ref, `/git/refs/heads/${encodeURIComponent(prepared.branch)}`), {
    method: 'PATCH',
    input: { sha: commit.sha, force: false },
    signal: ctx.signal,
  });

  return {
    repo: prepared.ref.full,
    summary: `Committed ${prepared.changes.length} change${prepared.changes.length === 1 ? '' : 's'} to ${prepared.branch}`,
    data: {
      kind: 'file-commit',
      branch: prepared.branch,
      commit: commit.sha,
      changes: prepared.changes.map((change) => ({ op: change.op, path: change.path ?? change.to, from: change.from ?? null, to: change.to ?? null })),
    },
    next: [nextStep('github_file', { action: 'stat', repo: prepared.ref.full, path: prepared.changes[0].path ?? prepared.changes[0].to, ref: prepared.branch }, 'verify the commit')],
  };
}

defineOperation({
  tool: 'github_file',
  action: 'commit',
  risk: 'write',
  async prepare(ctx, args) {
    return prepareCommit(ctx, args);
  },
  async plan(ctx, prepared) {
    return {
      summary: `Commit ${prepared.changes.length} change${prepared.changes.length === 1 ? '' : 's'} to ${prepared.branch}`,
      effects: prepared.changes.map((change) => `${change.op} ${change.path ?? change.from ?? ''}${change.to ? ` -> ${change.to}` : ''}`),
      warnings: isProtected(ctx.config, prepared.branch) ? [`Branch ${prepared.branch} is protected.`] : [],
    };
  },
  async apply(ctx, prepared) {
    return applyCommit(ctx, prepared);
  },
});

for (const [action, op, verb] of [['move', 'move', 'Moved'], ['copy', 'copy', 'Copied']]) {
  defineOperation({
    tool: 'github_file',
    action,
    risk: 'write',
    async prepare(ctx, args) {
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      if (message.length === 0) throw new GitHubError('message is required.', { code: 'validation' });
      const prepared = await prepareCommit(ctx, {
        ...args,
        message,
        changes: [{ op, from: args.from, to: args.to, overwrite: args.overwrite === true }],
      });
      return prepared;
    },
    async plan(ctx, prepared) {
      return {
        summary: `${verb} ${prepared.changes[0].from} to ${prepared.changes[0].to} on ${prepared.branch}`,
        effects: [`${verb === 'Moved' ? 'Move' : 'Copy'} ${prepared.changes[0].from} -> ${prepared.changes[0].to}`],
        warnings: isProtected(ctx.config, prepared.branch) ? [`Branch ${prepared.branch} is protected.`] : [],
      };
    },
    async apply(ctx, prepared) {
      return applyCommit(ctx, prepared);
    },
  });
}
