import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/actions.js';
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

function fakeGh(handler, commands = []) {
  return {
    async apiJson(config, endpoint, options = {}) { return handler(endpoint, options); },
    async apiList(config, endpoint) { return handler(endpoint, {}); },
    async command(config, args, options = {}) {
      commands.push({ args, options });
      return { stdout: 'line one\nline two\n', stderr: '' };
    },
  };
}

test('github_actions workflows projects the workflow list', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => ({ total_count: 1, workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }));
  const value = await runOperation(getOperation('github_actions', 'workflows'), { action: 'workflows', repo: 'owner/repo' }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_actions' },
    gh,
  });
  assert.equal(value.data.items.length, 1);
  assert.equal(value.data.items[0].name, 'CI');
});

test('github_actions dispatch asks for approval and sends inputs', async () => {
  const { session, approvals } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET', input: options.input });
    return {};
  });
  const value = await runOperation(getOperation('github_actions', 'dispatch'), {
    action: 'dispatch',
    repo: 'owner/repo',
    workflow: 'deploy.yml',
    ref: 'main',
    inputs: { environment: 'staging' },
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_actions', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(approvals.length, 1);
  const dispatch = calls.find((call) => call.endpoint.endsWith('/dispatches'));
  assert.equal(dispatch.input.ref, 'main');
  assert.equal(dispatch.input.inputs.environment, 'staging');
});

test('github_actions logs tail the command output', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => ({}));
  const value = await runOperation(getOperation('github_actions', 'logs'), {
    action: 'logs',
    repo: 'owner/repo',
    run_id: 42,
    tail: 5,
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_actions' },
    gh,
  });
  assert.equal(value.data.kind, 'run-logs');
  assert.ok(value.data.text.includes('line one'));
});

test('github_actions secrets_set reads a value from the environment', async () => {
  process.env.DSH_GITHUB_TEST_SECRET = 'super-secret-value';
  try {
    const { session, approvals } = fakeSession();
    const commands = [];
    const gh = fakeGh(() => ({}), commands);
    const value = await runOperation(getOperation('github_actions', 'secrets_set'), {
      action: 'secrets_set',
      repo: 'owner/repo',
      name: 'TOKEN',
      from_env: 'DSH_GITHUB_TEST_SECRET',
      apply: true,
      confirm: 'owner/repo:TOKEN',
    }, {
      config: resolveConfig({ allowAdmin: true }),
      session,
      exec: { toolName: 'github_actions', agent: { session: 'test' } },
      gh,
    });
    assert.equal(value.applied, true);
    assert.equal(approvals.length, 1);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].options.stdin, 'super-secret-value');
    assert.equal(commands[0].args[0], 'secret');
    assert.equal(commands[0].args[1], 'set');
  } finally {
    delete process.env.DSH_GITHUB_TEST_SECRET;
  }
});

test('github_actions secrets_set rejects a value argument', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => ({}), []);
  await assert.rejects(
    runOperation(getOperation('github_actions', 'secrets_set'), {
      action: 'secrets_set',
      repo: 'owner/repo',
      name: 'TOKEN',
      value: 'leaked',
      apply: true,
      confirm: 'owner/repo:TOKEN',
    }, {
      config: resolveConfig({ allowAdmin: true }),
      session,
      exec: { toolName: 'github_actions', agent: { session: 'test' } },
      gh,
    }),
    (error) => error.code === 'validation' && /must not be passed/.test(error.message),
  );
});
