import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/file.js';
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
    async apiList() {
      throw new Error('apiList is not used by file operations');
    },
  };
}

function notFound() {
  return new GitHubError('not found', { code: 'not_found' });
}

test('github_file write creates a file and asks for approval', async () => {
  const { session, approvals } = fakeSession();
  const calls = [];
  const gh = fakeGh((endpoint, options) => {
    calls.push({ endpoint, method: options.method ?? 'GET' });
    if (endpoint === 'repos/owner/repo') return { default_branch: 'main' };
    if (endpoint === 'repos/owner/repo/contents/file.txt?ref=main') throw notFound();
    if (endpoint === 'repos/owner/repo/contents/file.txt' && options.method === 'PUT') {
      return { commit: { sha: 'abc123' }, content: { sha: 'def456', html_url: 'https://github.com/owner/repo/blob/main/file.txt' } };
    }
    throw new Error(`unexpected ${options.method ?? 'GET'} ${endpoint}`);
  });

  const value = await runOperation(getOperation('github_file', 'write'), {
    action: 'write',
    repo: 'owner/repo',
    path: 'file.txt',
    content: 'hello\n',
    message: 'Add file',
  }, {
    config: resolveConfig({ protectedBranches: [] }),
    session,
    exec: { toolName: 'github_file', agent: { session: 'test' } },
    gh,
  });

  assert.equal(value.applied, true);
  assert.equal(value.data.kind, 'file-write');
  assert.equal(value.data.commit, 'abc123');
  assert.equal(approvals.length, 1);
  const put = calls.find((call) => call.method === 'PUT');
  assert.equal(put.endpoint, 'repos/owner/repo/contents/file.txt');
});

test('github_file write refuses to overwrite without the current sha', async () => {
  const { session } = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/repo') return { default_branch: 'main' };
    if (endpoint === 'repos/owner/repo/contents/file.txt?ref=main') {
      return { type: 'file', sha: 'old-sha', size: 5, path: 'file.txt' };
    }
    throw new Error(`unexpected ${endpoint}`);
  });

  await assert.rejects(
    runOperation(getOperation('github_file', 'write'), {
      action: 'write',
      repo: 'owner/repo',
      path: 'file.txt',
      content: 'new',
      message: 'Update',
    }, {
      config: resolveConfig({ protectedBranches: [] }),
      session,
      exec: { toolName: 'github_file' },
      gh,
    }),
    (error) => error.code === 'conflict' && error.hint.includes('old-sha'),
  );
});

test('github_file write refuses a protected branch at apply time', async () => {
  const { session } = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/repo') return { default_branch: 'main' };
    if (endpoint === 'repos/owner/repo/contents/file.txt?ref=main') throw notFound();
    throw new Error(`unexpected ${endpoint}`);
  });

  await assert.rejects(
    runOperation(getOperation('github_file', 'write'), {
      action: 'write',
      repo: 'owner/repo',
      path: 'file.txt',
      content: 'new',
      message: 'Add',
    }, {
      config: resolveConfig({ protectedBranches: ['main'] }),
      session,
      exec: { toolName: 'github_file', agent: { session: 'test' } },
      gh,
    }),
    (error) => error.code === 'policy' && error.hint.includes('allow_protected'),
  );
});

test('github_file stat reads file metadata without approval', async () => {
  const { session, approvals } = fakeSession();
  const gh = fakeGh((endpoint) => {
    assert.equal(endpoint, 'repos/owner/repo/contents/file.txt?ref=main');
    return { type: 'file', sha: 'abc', size: 12, path: 'file.txt', html_url: 'https://example.test/file' };
  });
  const value = await runOperation(getOperation('github_file', 'stat'), {
    action: 'stat',
    repo: 'owner/repo',
    path: 'file.txt',
    ref: 'main',
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_file' },
    gh,
  });
  assert.equal(value.applied, true);
  assert.equal(value.data.type, 'file');
  assert.equal(value.data.size, 12);
  assert.equal(approvals.length, 0);
});
