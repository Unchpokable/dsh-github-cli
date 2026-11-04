import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError, githubError, httpError, redact, retryAfterMs } from '../../lib/errors.js';

test('redact removes GitHub tokens and private keys', () => {
  const token = 'ghp_' + 'a'.repeat(36);
  const fine = 'github_pat_' + 'b'.repeat(30);
  const key = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----';
  const text = `token ${token} ${fine}\n${key}\nAuthorization: Bearer abcdefghijklmnop`;
  const clean = redact(text);
  assert.equal(clean.includes(token), false);
  assert.equal(clean.includes(fine), false);
  assert.equal(clean.includes('secret'), false);
  assert.ok(clean.includes('[redacted]'));
});

test('redact removes credentials from https URLs', () => {
  const clean = redact('https://user:pass@github.com/owner/repo');
  assert.equal(clean.includes('pass'), false);
  assert.ok(clean.includes('[redacted]:[redacted]@'));
});

test('githubError preserves the old auth message', () => {
  const error = githubError({ code: 1, stdout: '', stderr: 'Bad credentials' }, ['api', 'repos/owner/repo']);
  assert.equal(error.code, 'auth');
  assert.match(error.message, /GitHub authentication failed/);
  assert.match(error.message, /gh auth login/);
});

test('githubError classifies 404 and rate limit', () => {
  const notFound = githubError({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found' }, ['api', 'repos/x/y']);
  assert.equal(notFound.code, 'not_found');
  const rate = githubError({ code: 1, stdout: '', stderr: 'API rate limit exceeded', headers: { 'retry-after': '5' } }, ['api', 'x']);
  assert.equal(rate.code, 'rate_limit');
  assert.equal(rate.retryAfterMs, 5000);
});

test('httpError maps statuses', () => {
  assert.equal(httpError(401, 'Bad credentials').code, 'auth');
  assert.equal(httpError(403, 'Resource not accessible by integration').code, 'permission');
  assert.equal(httpError(404, 'Not Found').code, 'not_found');
  assert.equal(httpError(409, 'Conflict').code, 'conflict');
  assert.equal(httpError(422, 'Validation Failed').code, 'conflict');
  assert.equal(httpError(500, 'oops').code, 'network');
});

test('retryAfterMs reads seconds and reset headers', () => {
  assert.equal(retryAfterMs({ 'retry-after': '2' }), 2000);
  const reset = Math.floor(Date.now() / 1000) + 10;
  const value = retryAfterMs({ 'x-ratelimit-reset': String(reset) });
  assert.ok(value > 0 && value <= 10_000);
  assert.equal(retryAfterMs({}), null);
});

test('GitHubError serializes without a stack', () => {
  const error = new GitHubError('nope', { code: 'validation', hint: 'fix it', status: 422 });
  assert.deepEqual(error.toJSON(), {
    code: 'validation',
    message: 'nope',
    hint: 'fix it',
    status: 422,
    retryable: false,
  });
});
