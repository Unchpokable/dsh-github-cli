import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/repo.js';
import { resolveConfig } from '../../lib/config.js';
import { GitHubError } from '../../lib/errors.js';
import { parseRepoRef } from '../../lib/repo.js';

function fakeSession() {
  const approvals = [];
  const service = {
    async request(request) {
      approvals.push(request);
      return 'allowed-once';
    },
  };
  return {
    approvals,
    session: {
      cwd: 'C:\\work\\repo',
      auth: { account: 'tester' },
      defaults: { owner: 'tester', host: 'github.com' },
      bindings: new Map(),
      resolveRepo(input) {
        return parseRepoRef(input ?? 'owner/repo');
      },
      ctx: {
        get(name) {
          return name === 'approval' ? service : undefined;
        },
      },
      record(entry) {
        return { ...entry, id: entry.id ?? 'op_test' };
      },
    },
  };
}

function fakeGh(handler) {
  return {
    async apiJson(config, endpoint, options = {}) {
      return handler(endpoint, options);
    },
    async apiList(config, endpoint, options = {}) {
      return handler(endpoint, options);
    },
  };
}

test('github_repo create posts to the organization endpoint', async () => {
  const { session, approvals } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET' });
    if (endpoint === 'repos/my-org/new-repo') throw new GitHubError('not found', { code: 'not_found' });
    if (endpoint === 'orgs/my-org/repos' && options.method === 'POST') {
      return {
        full_name: 'my-org/new-repo',
        name: 'new-repo',
        owner: { login: 'my-org' },
        private: true,
        visibility: 'private',
        default_branch: 'main',
        html_url: 'https://github.com/my-org/new-repo',
      };
    }
    throw new Error(`unexpected ${options.method ?? 'GET'} ${endpoint}`);
  });

  const operation = getOperation('github_repo', 'create');
  const value = await runOperation(operation, {
    action: 'create',
    org: 'my-org',
    name: 'new-repo',
    visibility: 'private',
    auto_init: true,
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_repo', agent: { session: 'test' } },
    gh,
  });

  assert.equal(value.applied, true);
  assert.equal(value.repo, 'my-org/new-repo');
  assert.equal(approvals.length, 1);
  assert.ok(calls.some((call) => call.endpoint === 'orgs/my-org/repos' && call.method === 'POST'));
});

test('github_repo view is a read without approval', async () => {
  const { session, approvals } = fakeSession();
  const gh = fakeGh((endpoint) => {
    assert.equal(endpoint, 'repos/owner/repo');
    return { full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' }, private: true, default_branch: 'main' };
  });
  const value = await runOperation(getOperation('github_repo', 'view'), { action: 'view', repo: 'owner/repo' }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_repo' },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(value.data.repo.full_name, 'owner/repo');
  assert.equal(approvals.length, 0);
});

test('github_repo edit to public returns an admin-risk plan', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => {
    throw new Error('a plan must not write');
  });
  const value = await runOperation(getOperation('github_repo', 'edit'), {
    action: 'edit',
    repo: 'owner/repo',
    visibility: 'public',
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_repo' },
    gh,
  });
  assert.equal(value.applied, false);
  assert.equal(value.plan.risk, 'admin');
  assert.equal(value.next[0].args.apply, true);
});

test('github_repo edit with apply requires allowAdmin', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => ({ full_name: 'owner/repo' }));
  await assert.rejects(
    runOperation(getOperation('github_repo', 'edit'), {
      action: 'edit',
      repo: 'owner/repo',
      visibility: 'public',
      apply: true,
    }, {
      config: resolveConfig({ allowAdmin: false }),
      session,
      exec: { toolName: 'github_repo' },
      gh,
    }),
    (error) => error.code === 'policy',
  );
});

test('github_repo edit returns the updated topic list', async () => {
  const { session, approvals } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET' });
    if (endpoint === 'repos/owner/repo' && (options.method ?? 'GET') === 'GET') {
      return { full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' }, topics: ['old'] };
    }
    if (endpoint === 'repos/owner/repo' && options.method === 'PATCH') {
      return { full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' }, topics: ['old'] };
    }
    if (endpoint === 'repos/owner/repo/topics' && options.method === 'PUT') return {};
    throw new Error(`unexpected ${options.method ?? 'GET'} ${endpoint}`);
  });
  const value = await runOperation(getOperation('github_repo', 'edit'), {
    action: 'edit', repo: 'owner/repo', topics: ['dsh', 'github'],
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_repo', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.deepEqual(value.data.repo.topics, ['dsh', 'github']);
  assert.equal(approvals.length, 1);
  assert.ok(calls.some((call) => call.endpoint === 'repos/owner/repo/topics' && call.method === 'PUT'));
});

test('github_repo transfer returns a destructive plan and applies with confirm', async () => {
  const { session, approvals } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET' });
    if (endpoint === 'repos/owner/repo') return { full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' } };
    if (endpoint === 'repos/owner/repo/transfer' && options.method === 'POST') return { message: 'accepted' };
    throw new Error(`unexpected ${endpoint}`);
  });
  const operation = getOperation('github_repo', 'transfer');
  const plan = await runOperation(operation, { action: 'transfer', repo: 'owner/repo', new_owner: 'new-org' }, {
    config: resolveConfig({ allowDestructive: true }),
    session,
    exec: { toolName: 'github_repo' },
    gh,
  });
  assert.equal(plan.applied, false);
  assert.equal(plan.plan.confirm, 'owner/repo -> new-org');

  const value = await runOperation(operation, {
    action: 'transfer',
    repo: 'owner/repo',
    new_owner: 'new-org',
    apply: true,
    confirm: 'owner/repo -> new-org',
  }, {
    config: resolveConfig({ allowDestructive: true }),
    session,
    exec: { toolName: 'github_repo', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(value.repo, 'new-org/repo');
  assert.equal(approvals.length, 1);
  assert.ok(calls.some((call) => call.endpoint === 'repos/owner/repo/transfer' && call.method === 'POST'));
});

test('github_repo access_remove requires a matching confirm', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => ({}));
  const operation = getOperation('github_repo', 'access_remove');
  const plan = await runOperation(operation, { action: 'access_remove', repo: 'owner/repo', user: 'octocat' }, {
    config: resolveConfig({ allowDestructive: true }),
    session,
    exec: { toolName: 'github_repo' },
    gh,
  });
  assert.equal(plan.applied, false);
  assert.equal(plan.plan.confirm, 'owner/repo:octocat');
  await assert.rejects(
    runOperation(operation, {
      action: 'access_remove',
      repo: 'owner/repo',
      user: 'octocat',
      apply: true,
      confirm: 'wrong',
    }, {
      config: resolveConfig({ allowDestructive: true }),
      session,
      exec: { toolName: 'github_repo', agent: { session: 'test' } },
      gh,
    }),
    (error) => error.code === 'validation',
  );
});
