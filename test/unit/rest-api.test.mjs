import test from 'node:test';
import assert from 'node:assert/strict';
import { apiJson, apiList, apiRequest } from '../../lib/gh/rest.js';

const config = { timeoutMs: 5000, maxPages: 5 };

function included(status, body, headers = {}) {
  const lines = [`HTTP/2.0 ${status} OK`];
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
  lines.push('', body);
  return lines.join('\n');
}

test('apiRequest returns status, headers, body, and rate', async () => {
  const fake = async () => ({
    code: 0,
    stdout: included(200, '{"ok":true}', { 'X-RateLimit-Remaining': '42', 'X-RateLimit-Limit': '5000' }),
    stderr: '',
  });
  const response = await apiRequest(config, 'repos/owner/repo', { ghRun: fake });
  assert.equal(response.status, 200);
  assert.equal(response.body, '{"ok":true}');
  assert.equal(response.rate.remaining, 42);
});

test('apiJson parses a JSON body', async () => {
  const fake = async () => ({ code: 0, stdout: included(200, '{"number":7}'), stderr: '' });
  assert.deepEqual(await apiJson(config, 'repos/owner/repo/pulls/7', { ghRun: fake }), { number: 7 });
});

test('apiRequest throws a structured error for a 404', async () => {
  const fake = async () => ({ code: 1, stdout: included(404, '{"message":"Not Found"}'), stderr: '' });
  await assert.rejects(
    apiRequest(config, 'repos/owner/missing', { ghRun: fake }),
    (error) => error.code === 'not_found' && error.status === 404,
  );
});

test('apiList pages until a short page', async () => {
  let calls = 0;
  const fake = async (cfg, args) => {
    calls += 1;
    const endpoint = args[args.length - 1];
    const page = Number(new URL(`https://x/${endpoint}`).searchParams.get('page'));
    const items = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ n: i })) : [{ n: 100 }];
    return { code: 0, stdout: included(200, JSON.stringify(items)), stderr: '' };
  };
  const result = await apiList(config, 'repos/owner/repo/issues', { ghRun: fake });
  assert.equal(result.items.length, 101);
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.equal(calls, 2);
});
