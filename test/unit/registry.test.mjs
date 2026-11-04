import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearOperations,
  defineOperation,
  getOperation,
  listOperations,
  runOperation,
} from '../../lib/ops/registry.js';
import { resolveConfig } from '../../lib/config.js';

function makeSession(outcome = 'allowed-once') {
  const requests = [];
  const records = [];
  const service = {
    async request(request) {
      requests.push(request);
      return outcome;
    },
  };
  const ctx = {
    get(name) {
      return name === 'approval' ? service : undefined;
    },
  };
  const session = {
    ctx,
    record(entry) {
      records.push(entry);
      return { ...entry, id: entry.id ?? 'op_test' };
    },
  };
  return { session, requests, records };
}

function readOperation(overrides = {}) {
  return defineOperation({
    tool: 'github_test',
    action: 'read',
    risk: 'read',
    prepare: (ctx, args) => ({ repo: 'owner/repo', ...args }),
    apply: async () => ({ summary: 'read ok', repo: 'owner/repo', data: { n: 1 } }),
    ...overrides,
  });
}

test('defineOperation registers and rejects duplicates', () => {
  clearOperations();
  const operation = readOperation();
  assert.equal(getOperation('github_test', 'read'), operation);
  assert.equal(listOperations('github_test').length, 1);
  assert.throws(() => readOperation(), /already registered/);
});

test('runOperation applies a read operation without approval', async () => {
  clearOperations();
  const operation = readOperation();
  const { session, requests, records } = makeSession();
  const value = await runOperation(operation, {}, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_test' },
  });
  assert.equal(value.applied, true);
  assert.equal(value.summary, 'read ok');
  assert.equal(requests.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].operation, 'test.read');
});

test('runOperation asks for approval before a write', async () => {
  clearOperations();
  const operation = readOperation({
    risk: 'write',
    action: 'write',
    apply: async () => ({ summary: 'written', repo: 'owner/repo' }),
  });
  const { session, requests } = makeSession('allowed-once');
  const value = await runOperation(operation, {}, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_test', callId: 'call-1', agent: { session: 'test' } },
  });
  assert.equal(value.applied, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolName, 'github_test');
  assert.equal(requests[0].callId, 'call-1');
});

test('runOperation does not apply when approval is rejected', async () => {
  clearOperations();
  let applied = false;
  const operation = readOperation({
    risk: 'write',
    action: 'write',
    apply: async () => {
      applied = true;
      return { summary: 'written' };
    },
  });
  const { session } = makeSession('rejected');
  await assert.rejects(
    runOperation(operation, {}, { config: resolveConfig({}), session, exec: { toolName: 'github_test', agent: { session: 'test' } } }),
    (error) => error.code === 'cancelled',
  );
  assert.equal(applied, false);
});

test('runOperation returns a plan for destructive work without apply', async () => {
  clearOperations();
  const operation = readOperation({
    risk: 'destructive',
    action: 'delete',
    plan: () => ({ summary: 'delete repo', confirm: 'owner/repo', effects: ['gone'] }),
    apply: async () => ({ summary: 'deleted' }),
  });
  const { session, requests } = makeSession();
  const value = await runOperation(operation, {}, {
    config: resolveConfig({ allowDestructive: true }),
    session,
    exec: { toolName: 'github_test' },
  });
  assert.equal(value.applied, false);
  assert.equal(value.plan.confirm, 'owner/repo');
  assert.equal(value.next[0].args.apply, true);
  assert.equal(value.next[0].args.confirm, 'owner/repo');
  assert.equal(requests.length, 0);
});

test('runOperation applies a destructive operation with allow/apply/confirm', async () => {
  clearOperations();
  let applied = false;
  const operation = readOperation({
    risk: 'destructive',
    action: 'delete',
    plan: () => ({ summary: 'delete repo', confirm: 'owner/repo' }),
    apply: async () => {
      applied = true;
      return { summary: 'deleted' };
    },
  });
  const { session, requests } = makeSession();
  const value = await runOperation(operation, { apply: true, confirm: 'owner/repo' }, {
    config: resolveConfig({ allowDestructive: true }),
    session,
    exec: { toolName: 'github_test', agent: { session: 'test' } },
  });
  assert.equal(value.applied, true);
  assert.equal(applied, true);
  assert.equal(requests.length, 1);
});

test('runOperation refuses destructive work when allowDestructive is false', async () => {
  clearOperations();
  const operation = readOperation({
    risk: 'destructive',
    action: 'delete',
    plan: () => ({ summary: 'delete repo', confirm: 'owner/repo' }),
    apply: async () => ({ summary: 'deleted' }),
  });
  const { session } = makeSession();
  await assert.rejects(
    runOperation(operation, { apply: true, confirm: 'owner/repo' }, {
      config: resolveConfig({}),
      session,
      exec: { toolName: 'github_test' },
    }),
    (error) => error.code === 'policy',
  );
});

test('getOperation reports the available actions', () => {
  clearOperations();
  readOperation({ action: 'one' });
  readOperation({ action: 'two' });
  assert.throws(
    () => getOperation('github_test', 'missing'),
    (error) => error.code === 'validation' && error.hint.includes('one') && error.hint.includes('two'),
  );
});
