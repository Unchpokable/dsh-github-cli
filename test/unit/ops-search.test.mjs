import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, runOperation } from '../../lib/ops/registry.js';
import '../../lib/ops/search.js';
import { resolveConfig } from '../../lib/config.js';

test('github_search projects repository results', async () => {
  const calls = [];
  const gh = {
    async apiJson(config, endpoint) {
      calls.push(endpoint);
      return {
        total_count: 1,
        incomplete_results: false,
        items: [{ full_name: 'owner/repo', name: 'repo', description: 'desc', stargazers_count: 5, html_url: 'https://example.test/repo' }],
      };
    },
  };
  const value = await runOperation(getOperation('github_search', 'search'), {
    action: 'search',
    kind: 'repositories',
    query: 'dsh',
    limit: 5,
  }, {
    config: resolveConfig({}),
    session: { cwd: 'C:\\work', auth: { account: 'tester' }, ctx: { get: () => undefined }, record() {} },
    exec: { toolName: 'github_search' },
    gh,
  });
  assert.equal(value.data.items[0].full_name, 'owner/repo');
  assert.ok(calls[0].startsWith('search/repositories?q=dsh'));
});

test('github_search rejects an unknown kind', async () => {
  await assert.rejects(
    runOperation(getOperation('github_search', 'search'), { action: 'search', kind: 'nope', query: 'x' }, {
      config: resolveConfig({}),
      session: { cwd: 'C:\\work', auth: {}, ctx: { get: () => undefined }, record() {} },
      exec: { toolName: 'github_search' },
      gh: { async apiJson() { throw new Error('must not call'); } },
    }),
    (error) => error.code === 'validation',
  );
});
