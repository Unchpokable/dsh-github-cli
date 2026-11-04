import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/release.js';
import { resolveConfig } from '../../lib/config.js';
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

test('github_release list projects releases', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => ({ items: [{ id: 1, tag_name: 'v1', name: 'v1', draft: false }], complete: true }));
  const value = await runOperation(getOperation('github_release', 'list'), { action: 'list', repo: 'owner/repo' }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_release' },
    gh,
  });
  assert.equal(value.data.items[0].tag_name, 'v1');
});

test('github_release create asks for approval', async () => {
  const { session, approvals } = fakeSession();
  const gh = fakeGh((endpoint, options) => {
    assert.equal(endpoint, 'repos/owner/repo/releases');
    assert.equal(options.method, 'POST');
    return { id: 2, tag_name: 'v2', html_url: 'https://example.test/v2' };
  });
  const value = await runOperation(getOperation('github_release', 'create'), {
    action: 'create',
    repo: 'owner/repo',
    tag: 'v2',
    name: 'v2',
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_release', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(approvals.length, 1);
});

test('github_release delete requires a destructive plan', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => ({}));
  const value = await runOperation(getOperation('github_release', 'delete'), {
    action: 'delete',
    repo: 'owner/repo',
    tag: 'v2',
  }, {
    config: resolveConfig({ allowDestructive: true }),
    session,
    exec: { toolName: 'github_release' },
    gh,
  });
  assert.equal(value.applied, false);
  assert.equal(value.plan.confirm, 'owner/repo:v2');
});
