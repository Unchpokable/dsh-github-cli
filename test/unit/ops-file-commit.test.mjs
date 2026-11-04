import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/file.js';
import { resolveConfig } from '../../lib/config.js';
import { GitHubError } from '../../lib/errors.js';
import { parseRepoRef } from '../../lib/repo.js';

function fakeSession() {
  const approvals = [];
  const service = { async request(request) { approvals.push(request); return 'allowed-once'; } };
  return {
    approvals,
    session: {
      cwd: 'C:\\work\\repo',
      auth: { account: 'tester' },
      resolveRepo(input) { return parseRepoRef(input ?? 'owner/repo'); },
      ctx: { get: (name) => (name === 'approval' ? service : undefined) },
      record(entry) { return { ...entry, id: entry.id ?? 'op_test' }; },
    },
  };
}

function fakeGh(handler) {
  return {
    async apiJson(config, endpoint, options = {}) { return handler(endpoint, options); },
  };
}

function baseHandler(extra) {
  return (endpoint, options = {}) => {
    const method = options.method ?? 'GET';
    if (endpoint === 'repos/owner/repo' && method === 'GET') return { default_branch: 'main' };
    if (endpoint === 'repos/owner/repo/git/ref/heads/main' && method === 'GET') return { object: { sha: 'head-sha' } };
    if (endpoint === 'repos/owner/repo/git/commits/head-sha' && method === 'GET') return { tree: { sha: 'tree-sha' } };
    return extra(endpoint, options);
  };
}

test('github_file move references the existing blob and deletes the old path', async () => {
  const { session, approvals } = fakeSession();
  const trees = [];
  const gh = fakeGh(baseHandler((endpoint, options = {}) => {
    const method = options.method ?? 'GET';
    if (endpoint === 'repos/owner/repo/contents/a.txt?ref=main' && method === 'GET') return { type: 'file', sha: 'blob-a', size: 2 };
    if (endpoint === 'repos/owner/repo/contents/b.txt?ref=main' && method === 'GET') throw new GitHubError('not found', { code: 'not_found' });
    if (endpoint === 'repos/owner/repo/git/trees' && method === 'POST') {
      trees.push(options.input);
      return { sha: 'new-tree' };
    }
    if (endpoint === 'repos/owner/repo/git/commits' && method === 'POST') return { sha: 'new-commit' };
    if (endpoint === 'repos/owner/repo/git/refs/heads/main' && method === 'PATCH') return { object: { sha: 'new-commit' } };
    throw new Error(`unexpected ${method} ${endpoint}`);
  }));

  const value = await runOperation(getOperation('github_file', 'move'), {
    action: 'move',
    repo: 'owner/repo',
    from: 'a.txt',
    to: 'b.txt',
    message: 'Move a to b',
  }, {
    config: resolveConfig({ protectedBranches: [] }),
    session,
    exec: { toolName: 'github_file', agent: { session: 'test' } },
    gh,
  });

  assert.equal(value.applied, true);
  assert.equal(approvals.length, 1);
  assert.equal(trees[0].base_tree, 'tree-sha');
  assert.deepEqual(trees[0].tree.find((entry) => entry.path === 'b.txt'), { path: 'b.txt', mode: '100644', type: 'blob', sha: 'blob-a' });
  assert.deepEqual(trees[0].tree.find((entry) => entry.path === 'a.txt'), { path: 'a.txt', mode: '100644', type: 'blob', sha: null });
});

test('github_file commit writes a blob and creates one tree/commit', async () => {
  const { session } = fakeSession();
  let blobCalls = 0;
  let treeCalls = 0;
  const gh = fakeGh(baseHandler((endpoint, options = {}) => {
    const method = options.method ?? 'GET';
    if (endpoint === 'repos/owner/repo/git/blobs' && method === 'POST') {
      blobCalls += 1;
      return { sha: 'new-blob' };
    }
    if (endpoint === 'repos/owner/repo/git/trees' && method === 'POST') {
      treeCalls += 1;
      return { sha: 'new-tree' };
    }
    if (endpoint === 'repos/owner/repo/git/commits' && method === 'POST') return { sha: 'new-commit' };
    if (endpoint === 'repos/owner/repo/git/refs/heads/main' && method === 'PATCH') return { object: { sha: 'new-commit' } };
    if (endpoint === 'repos/owner/repo/contents/new.txt?ref=main' && method === 'GET') throw new GitHubError('not found', { code: 'not_found' });
    throw new Error(`unexpected ${method} ${endpoint}`);
  }));

  const value = await runOperation(getOperation('github_file', 'commit'), {
    action: 'commit',
    repo: 'owner/repo',
    message: 'Add new file',
    changes: [{ op: 'write', path: 'new.txt', content: 'hello' }],
  }, {
    config: resolveConfig({ protectedBranches: [] }),
    session,
    exec: { toolName: 'github_file', agent: { session: 'test' } },
    gh,
  });

  assert.equal(value.applied, true);
  assert.equal(blobCalls, 1);
  assert.equal(treeCalls, 1);
  assert.equal(value.data.commit, 'new-commit');
});
