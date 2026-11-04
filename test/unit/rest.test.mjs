import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIncludedResponse, rateLimitFromHeaders } from '../../lib/gh/rest.js';

const sample = [
  'HTTP/2.0 200 OK',
  'Content-Type: application/json; charset=utf-8',
  'X-RateLimit-Limit: 5000',
  'X-RateLimit-Remaining: 4999',
  'X-RateLimit-Used: 1',
  'X-RateLimit-Reset: 1793818998',
  'X-RateLimit-Resource: core',
  '',
  '{"ok":true}',
].join('\r\n');

test('parseIncludedResponse splits status, headers, and body', () => {
  const parsed = parseIncludedResponse(sample);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(parsed.headers['x-ratelimit-limit'], '5000');
  assert.equal(parsed.body, '{"ok":true}');
});

test('parseIncludedResponse tolerates a body without headers', () => {
  const parsed = parseIncludedResponse('{"ok":true}');
  assert.equal(parsed.status, null);
  assert.deepEqual(parsed.headers, {});
  assert.equal(parsed.body, '{"ok":true}');
});

test('parseIncludedResponse handles folded header values', () => {
  const input = ['HTTP/1.1 403 Forbidden', 'X-Test: one', '  two', '', 'no'].join('\n');
  const parsed = parseIncludedResponse(input);
  assert.equal(parsed.status, 403);
  assert.equal(parsed.headers['x-test'], 'one two');
  assert.equal(parsed.body, 'no');
});

test('parseIncludedResponse tolerates a UTF-8 BOM', () => {
  const parsed = parseIncludedResponse(`\uFEFF${sample}`);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body, '{"ok":true}');
});

test('rateLimitFromHeaders normalizes the budget', () => {
  const rate = rateLimitFromHeaders({
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '10',
    'x-ratelimit-used': '4990',
    'x-ratelimit-reset': '1793818998',
    'x-ratelimit-resource': 'core',
  });
  assert.equal(rate.limit, 5000);
  assert.equal(rate.remaining, 10);
  assert.equal(rate.used, 4990);
  assert.equal(rate.resource, 'core');
  assert.equal(rate.reset, 1793818998);
  assert.equal(rateLimitFromHeaders({}), null);
});
