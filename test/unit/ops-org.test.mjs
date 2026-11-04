import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/org.js';
import { resolveConfig } from '../../lib/config.js';

function fakeSession() {
  const approvals = [];
  const service = { async request(request) { approvals.push(request); return 'allowed-once'; } };
  return {
    approvals,
    session: {
      auth: { account: 'tester' },
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

test('github_org list projects organizations', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => ({ items: [{ login: 'my-org', name: 'My Org' }], complete: true }));
  const value = await runOperation(getOperation('github_org', 'list'), { action: 'list' }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_org' },
    gh,
  });
  assert.equal(value.data.items.length, 1);
  assert.equal(value.data.items[0].login, 'my-org');
});

test('github_org team_repos_add is admin-risk and grants permission', async () => {
  const { session, approvals } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET', input: options.input });
    return {};
  });
  const value = await runOperation(getOperation('github_org', 'team_repos_add'), {
    action: 'team_repos_add',
    org: 'my-org',
    team_slug: 'platform',
    repo: 'my-org/api',
    permission: 'push',
    apply: true,
  }, {
    config: resolveConfig({ allowAdmin: true }),
    session,
    exec: { toolName: 'github_org', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(approvals.length, 1);
  const call = calls.find((entry) => entry.method === 'PUT');
  assert.equal(call.endpoint, 'orgs/my-org/teams/platform/repos/my-org/api');
  assert.equal(call.input.permission, 'push');
});
