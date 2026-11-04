import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/ref.js';
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
    async apiList(config, endpoint) { return handler(endpoint, {}); },
  };
}

test('github_ref create resolves a base branch and posts the ref', async () => {
  const { session, approvals } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET' });
    if (endpoint === 'repos/owner/repo/git/ref/heads/main') return { object: { sha: 'a'.repeat(40) } };
    if (endpoint === 'repos/owner/repo/git/refs' && options.method === 'POST') {
      return { ref: 'refs/heads/feature', object: { sha: 'a'.repeat(40) } };
    }
    throw new Error(`unexpected ${options.method ?? 'GET'} ${endpoint}`);
  });
  const value = await runOperation(getOperation('github_ref', 'create'), {
    action: 'create',
    repo: 'owner/repo',
    ref: 'feature',
    from: 'main',
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_ref', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(value.data.name, 'feature');
  assert.equal(approvals.length, 1);
  assert.ok(calls.some((call) => call.method === 'POST'));
});

test('github_ref delete refuses the default branch', async () => {
  const { session } = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/repo/branches/main') return { name: 'main', protected: true };
    if (endpoint === 'repos/owner/repo') return { default_branch: 'main' };
    throw new Error(`unexpected ${endpoint}`);
  });
  await assert.rejects(
    runOperation(getOperation('github_ref', 'delete'), { action: 'delete', repo: 'owner/repo', ref: 'main' }, {
      config: resolveConfig({ allowDestructive: true }),
      session,
      exec: { toolName: 'github_ref' },
      gh,
    }),
    (error) => error.code === 'policy',
  );
});

test('github_ref delete of a protected branch needs allow_protected', async () => {
  const { session } = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/repo/branches/release') return { name: 'release', protected: true };
    if (endpoint === 'repos/owner/repo') return { default_branch: 'main' };
    throw new Error(`unexpected ${endpoint}`);
  });
  await assert.rejects(
    runOperation(getOperation('github_ref', 'delete'), { action: 'delete', repo: 'owner/repo', ref: 'release' }, {
      config: resolveConfig({ allowDestructive: true }),
      session,
      exec: { toolName: 'github_ref' },
      gh,
    }),
    (error) => error.code === 'policy',
  );
});

test('github_ref list projects branch metadata', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => ({
    items: [{ name: 'main', commit: { sha: 'abc' }, protected: true }],
  }));
  // apiList returns {items}; the operation expects that shape.
  const value = await runOperation(getOperation('github_ref', 'list'), { action: 'list', repo: 'owner/repo' }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_ref' },
    gh,
  });
  assert.equal(value.data.items.length, 1);
  assert.equal(value.data.items[0].protected, true);
});
