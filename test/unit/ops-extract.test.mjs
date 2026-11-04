import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/extract.js';
import { resolveConfig } from '../../lib/config.js';
import { GitHubError } from '../../lib/errors.js';
import { parseRepoRef } from '../../lib/repo.js';

function fakeSession() {
  return {
    cwd: 'C:\\work\\repo',
    auth: { account: 'tester' },
    defaults: { owner: 'tester', host: 'github.com' },
    resolveRepo(input) { return parseRepoRef(input ?? 'owner/mono'); },
    ctx: { get: () => undefined },
    record(entry) { return { ...entry, id: entry.id ?? 'op_test' }; },
  };
}

function fakeGh(handler) {
  return {
    async apiJson(config, endpoint) { return handler(endpoint); },
  };
}

test('github_extract plan supports multiple paths with filter-repo', async () => {
  const session = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/mono/commits/main') return { sha: 'a'.repeat(40), commit: { tree: { sha: 'tree-sha' } } };
    if (endpoint === 'repos/owner/mono/git/trees/tree-sha?recursive=1') {
      return {
        tree: [
          { path: 'packages/api/a.ts', type: 'blob', size: 10 },
          { path: 'packages/shared/b.ts', type: 'blob', size: 20 },
          { path: 'packages/web/c.ts', type: 'blob', size: 99 },
        ],
      };
    }
    if (endpoint === 'repos/my-org/api') throw new GitHubError('not found', { code: 'not_found' });
    throw new Error(`unexpected ${endpoint}`);
  });
  const value = await runOperation(getOperation('github_extract', 'plan'), {
    action: 'plan',
    source: { repo: 'owner/mono', ref: 'main', paths: ['packages/api', 'packages/shared'] },
    destination: { owner: 'my-org', name: 'api' },
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_extract' },
    gh,
  });
  assert.equal(value.plan.details.strategy, 'filter-repo');
  assert.equal(value.plan.details.stats.files, 2);
  assert.equal(value.plan.confirm, 'owner/mono:packages/api, packages/shared -> my-org/api');
});

test('github_extract plan detects LFS attributes', async () => {
  const session = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/mono/commits/main') return { sha: 'a'.repeat(40), commit: { tree: { sha: 'tree-sha' } } };
    if (endpoint === 'repos/owner/mono/git/trees/tree-sha?recursive=1') {
      return { tree: [{ path: 'packages/api/big.bin', type: 'blob', size: 100 }] };
    }
    if (endpoint === 'repos/owner/mono/contents/.gitattributes?ref=' + 'a'.repeat(40)) {
      return { content: Buffer.from('*.bin filter=lfs diff=lfs merge=lfs -text\n').toString('base64'), encoding: 'base64' };
    }
    if (endpoint === 'repos/my-org/api') throw new GitHubError('not found', { code: 'not_found' });
    throw new Error(`unexpected ${endpoint}`);
  });
  const value = await runOperation(getOperation('github_extract', 'plan'), {
    action: 'plan',
    source: { repo: 'owner/mono', ref: 'main', path: 'packages/api' },
    destination: { owner: 'my-org', name: 'api' },
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_extract' },
    gh,
  });
  assert.equal(value.plan.details.stats.lfs, true);
  assert.ok(value.plan.warnings.some((warning) => warning.includes('LFS')));
});

test('github_extract link plans a submodule replacement', async () => {
  const session = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/mono') return { default_branch: 'main' };
    if (endpoint === 'repos/owner/api') return { default_branch: 'main', clone_url: 'https://github.com/owner/api.git' };
    if (endpoint === 'repos/owner/mono/commits/main') return { sha: 'source-sha', commit: { tree: { sha: 'source-tree' } } };
    if (endpoint === 'repos/owner/api/commits/main') return { sha: 'target-sha', commit: { tree: { sha: 'target-tree' } } };
    if (endpoint === 'repos/owner/mono/git/trees/source-tree?recursive=1') {
      return { tree: [{ path: 'packages/api/a.ts', type: 'blob', size: 1 }, { path: 'packages/api/b.ts', type: 'blob', size: 2 }] };
    }
    if (endpoint === 'repos/owner/mono/contents/.gitmodules?ref=source-sha') throw new GitHubError('not found', { code: 'not_found' });
    throw new Error(`unexpected ${endpoint}`);
  });

  const value = await runOperation(getOperation('github_extract', 'link'), {
    action: 'link',
    source: { repo: 'owner/mono', ref: 'main', path: 'packages/api' },
    target: { repo: 'owner/api' },
  }, {
    config: resolveConfig({ allowDestructive: true }),
    session,
    exec: { toolName: 'github_extract' },
    gh,
  });

  assert.equal(value.applied, false);
  assert.equal(value.plan.confirm, 'owner/mono:packages/api <- owner/api');
  assert.equal(value.plan.details.files, 2);
  assert.equal(value.plan.details.branch, 'dsh/link-packages-api');
});

test('github_extract plan reports files, bytes, and confirm string', async () => {
  const session = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/mono/commits/main') {
      return { sha: 'a'.repeat(40), commit: { tree: { sha: 'tree-sha' } } };
    }
    if (endpoint === 'repos/owner/mono/git/trees/tree-sha?recursive=1') {
      return {
        tree: [
          { path: 'packages/api/src/a.ts', type: 'blob', size: 100 },
          { path: 'packages/api/package.json', type: 'blob', size: 50 },
          { path: 'packages/web/src/b.ts', type: 'blob', size: 999 },
        ],
        truncated: false,
      };
    }
    if (endpoint === 'repos/my-org/api') throw new GitHubError('not found', { code: 'not_found' });
    throw new Error(`unexpected ${endpoint}`);
  });

  const value = await runOperation(getOperation('github_extract', 'plan'), {
    action: 'plan',
    source: { repo: 'owner/mono', ref: 'main', path: 'packages/api' },
    destination: { owner: 'my-org', name: 'api' },
  }, {
    config: resolveConfig({}),
    session,
    exec: { toolName: 'github_extract' },
    gh,
  });

  assert.equal(value.applied, false);
  assert.equal(value.plan.confirm, 'owner/mono:packages/api -> my-org/api');
  assert.equal(value.plan.details.stats.files, 2);
  assert.equal(value.plan.details.stats.bytes, 150);
  assert.equal(value.plan.details.strategy, 'subtree-split');
});

test('github_extract plan rejects a missing path', async () => {
  const session = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/mono/commits/main') {
      return { sha: 'a'.repeat(40), commit: { tree: { sha: 'tree-sha' } } };
    }
    if (endpoint === 'repos/owner/mono/git/trees/tree-sha?recursive=1') {
      return { tree: [{ path: 'other/a.ts', type: 'blob', size: 1 }] };
    }
    if (endpoint === 'repos/my-org/api') throw new GitHubError('not found', { code: 'not_found' });
    throw new Error(`unexpected ${endpoint}`);
  });
  await assert.rejects(
    runOperation(getOperation('github_extract', 'plan'), {
      action: 'plan',
      source: { repo: 'owner/mono', ref: 'main', path: 'packages/missing' },
      destination: { owner: 'my-org', name: 'api' },
    }, {
      config: resolveConfig({}),
      session,
      exec: { toolName: 'github_extract' },
      gh,
    }),
    (error) => error.code === 'not_found',
  );
});

test('github_extract plan refuses a missing destination in create:false mode', async () => {
  const session = fakeSession();
  const gh = fakeGh((endpoint) => {
    if (endpoint === 'repos/owner/mono/commits/main') {
      return { sha: 'a'.repeat(40), commit: { tree: { sha: 'tree-sha' } } };
    }
    if (endpoint === 'repos/owner/mono/git/trees/tree-sha?recursive=1') {
      return { tree: [{ path: 'packages/api/a.ts', type: 'blob', size: 1 }] };
    }
    if (endpoint === 'repos/my-org/api') throw new GitHubError('not found', { code: 'not_found' });
    throw new Error(`unexpected ${endpoint}`);
  });
  await assert.rejects(
    runOperation(getOperation('github_extract', 'plan'), {
      action: 'plan',
      source: { repo: 'owner/mono', ref: 'main', path: 'packages/api' },
      destination: { owner: 'my-org', name: 'api', create: false },
    }, {
      config: resolveConfig({}),
      session,
      exec: { toolName: 'github_extract' },
      gh,
    }),
    (error) => error.code === 'not_found',
  );
});
