import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/api.js';
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

function fakeGh(body = '{"ok":true}') {
  const requests = [];
  return {
    requests,
    async apiRequest(config, endpoint, options = {}) {
      requests.push({ endpoint, ...options });
      return { status: 200, headers: {}, body };
    },
    async graphql() { return { viewer: { login: 'tester' } }; },
  };
}

test('github_api read sends a GET and selects a field', async () => {
  const { session } = fakeSession();
  const gh = fakeGh('{"ok":true,"nested":{"value":7}}');
  const value = await runOperation(getOperation('github_api', 'request'), {
    action: 'request',
    path: '/repos/owner/repo',
    select: 'nested.value',
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_api' },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(value.data.response, 7);
});

test('github_api rejects a write when allowGenericApi is read', async () => {
  const { session } = fakeSession();
  const gh = fakeGh();
  await assert.rejects(
    runOperation(getOperation('github_api', 'request'), {
      action: 'request',
      method: 'POST',
      path: '/repos/owner/repo/issues',
      body: { title: 'x' },
      allow_write: true,
    }, {
      config: resolveConfig({ allowGenericApi: 'read' }),
      session,
      exec: { toolName: 'github_api' },
      gh,
    }),
    (error) => error.code === 'policy',
  );
});

test('github_api DELETE requires admin, apply, and confirm', async () => {
  const { session, approvals } = fakeSession();
  const gh = fakeGh('');
  const operation = getOperation('github_api', 'request');
  const plan = await runOperation(operation, {
    action: 'request',
    method: 'DELETE',
    path: '/repos/owner/repo',
    allow_write: true,
  }, {
    config: resolveConfig({ allowGenericApi: 'write', allowAdmin: true }),
    session,
    exec: { toolName: 'github_api' },
    gh,
  });
  assert.equal(plan.applied, false);
  assert.equal(plan.plan.risk, 'admin');
  assert.equal(plan.plan.confirm, 'repos/owner/repo');

  const value = await runOperation(operation, {
    action: 'request',
    method: 'DELETE',
    path: '/repos/owner/repo',
    allow_write: true,
    apply: true,
    confirm: 'repos/owner/repo',
  }, {
    config: resolveConfig({ allowGenericApi: 'write', allowAdmin: true }),
    session,
    exec: { toolName: 'github_api', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(approvals.length, 1);
});
