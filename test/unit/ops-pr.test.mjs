import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/pr.js';
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
    async graphql() { return {}; },
  };
}

test('github_pr list returns projected pull requests', async () => {
  const { session, approvals } = fakeSession();
  const gh = fakeGh(() => ({
    items: [{ number: 7, title: 'Fix', state: 'open', draft: false, user: { login: 'octocat' } }],
    complete: true,
  }));
  const value = await runOperation(getOperation('github_pr', 'list'), { action: 'list', repo: 'owner/repo' }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_pr' },
    gh,
  });
  assert.equal(value.data.items.length, 1);
  assert.equal(value.data.items[0].number, 7);
  assert.equal(approvals.length, 0);
});

test('github_pr comment asks for approval and posts to the issue comments endpoint', async () => {
  const { session, approvals } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET' });
    return { id: 1, html_url: 'https://example.test/comment' };
  });
  const value = await runOperation(getOperation('github_pr', 'comment'), {
    action: 'comment',
    repo: 'owner/repo',
    pr: '7',
    body: 'Looks good',
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_pr', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(approvals.length, 1);
  assert.ok(calls.some((call) => call.endpoint === 'repos/owner/repo/issues/7/comments' && call.method === 'POST'));
});

test('github_pr merge returns a destructive plan first', async () => {
  const { session } = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/repo/pulls/7') {
      return { number: 7, state: 'open', mergeable: true, head: { sha: 'head-sha', ref: 'feature' }, base: { ref: 'main' } };
    }
    if (endpoint === 'repos/owner/repo') return { default_branch: 'main' };
    throw new Error(`unexpected ${endpoint}`);
  });
  const value = await runOperation(getOperation('github_pr', 'merge'), {
    action: 'merge',
    repo: 'owner/repo',
    pr: '7',
  }, {
    config: resolveConfig({ allowDestructive: true }),
    session,
    exec: { toolName: 'github_pr' },
    gh,
  });
  assert.equal(value.applied, false);
  assert.equal(value.plan.confirm, 'owner/repo#7');
  assert.equal(value.plan.risk, 'destructive');
});

test('github_pr merge applies with allow/apply/confirm and sends the head sha', async () => {
  const { session, approvals } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET', input: options.input });
    if (endpoint === 'repos/owner/repo/pulls/7') {
      return { number: 7, state: 'open', mergeable: true, head: { sha: 'head-sha', ref: 'feature' }, base: { ref: 'main' } };
    }
    if (endpoint === 'repos/owner/repo') return { default_branch: 'main' };
    if (endpoint === 'repos/owner/repo/pulls/7/merge' && options.method === 'PUT') return { merged: true, message: 'merged' };
    throw new Error(`unexpected ${endpoint}`);
  });
  const value = await runOperation(getOperation('github_pr', 'merge'), {
    action: 'merge',
    repo: 'owner/repo',
    pr: '7',
    apply: true,
    confirm: 'owner/repo#7',
  }, {
    config: resolveConfig({ allowDestructive: true }),
    session,
    exec: { toolName: 'github_pr', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(approvals.length, 1);
  const mergeCall = calls.find((call) => call.endpoint.endsWith('/merge'));
  assert.equal(mergeCall.input.sha, 'head-sha');
});
