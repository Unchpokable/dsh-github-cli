import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/issue.js';
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

test('github_issue list excludes pull requests by default', async () => {
  const { session } = fakeSession();
  const gh = fakeGh(() => ({
    items: [
      { number: 1, title: 'Bug', state: 'open', user: { login: 'a' } },
      { number: 2, title: 'PR', state: 'open', user: { login: 'b' }, pull_request: {} },
    ],
    complete: true,
  }));
  const value = await runOperation(getOperation('github_issue', 'list'), { action: 'list', repo: 'owner/repo' }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_issue' },
    gh,
  });
  assert.equal(value.data.items.length, 1);
  assert.equal(value.data.items[0].number, 1);
});

test('github_issue create posts and asks for approval', async () => {
  const { session, approvals } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET', input: options.input });
    return { number: 9, title: 'New', state: 'open', html_url: 'https://example.test/9' };
  });
  const value = await runOperation(getOperation('github_issue', 'create'), {
    action: 'create',
    repo: 'owner/repo',
    title: 'New',
    body: 'Body',
    labels: ['bug'],
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_issue', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(approvals.length, 1);
  const post = calls.find((call) => call.method === 'POST');
  assert.equal(post.endpoint, 'repos/owner/repo/issues');
  assert.deepEqual(post.input.labels, ['bug']);
});

test('github_issue comment resolves an issue URL', async () => {
  const { session } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET', input: options.input });
    return { id: 1, html_url: 'https://example.test/c' };
  });
  const value = await runOperation(getOperation('github_issue', 'comment'), {
    action: 'comment',
    repo: 'owner/repo',
    issue: 'https://github.com/owner/repo/issues/9',
    body: 'A comment',
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_issue', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(calls[0].endpoint, 'repos/owner/repo/issues/9/comments');
});

test('github_issue label adds and removes labels', async () => {
  const { session } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET' });
    return {};
  });
  const value = await runOperation(getOperation('github_issue', 'label'), {
    action: 'label',
    repo: 'owner/repo',
    issue: '9',
    add: ['bug'],
    remove: ['wontfix'],
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_issue', agent: { session: 'test' } },
    gh,
  });
  assert.equal(value.applied, true);
  assert.ok(calls.some((call) => call.method === 'POST'));
  assert.ok(calls.some((call) => call.method === 'DELETE'));
});
