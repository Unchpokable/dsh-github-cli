import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSession } from '../../lib/session.js';
import { resolveConfig } from '../../lib/config.js';

function makeSession(overrides = {}) {
  return new GitHubSession(resolveConfig({ defaultHost: 'github.com', ...overrides }), null);
}

test('resolveRepo accepts an explicit reference', () => {
  const session = makeSession();
  const ref = session.resolveRepo('owner/repo');
  assert.equal(ref.full, 'owner/repo');
  assert.equal(ref.host, 'github.com');
});

test('resolveRepo uses a cwd binding before the default', () => {
  const session = makeSession({ defaultRepo: 'default/repo' });
  session.bind('C:\\work\\repo', 'owner/bound');
  const ref = session.resolveRepo(undefined, { cwd: 'C:\\work\\repo\\src' });
  assert.equal(ref.full, 'owner/bound');
});

test('resolveRepo falls back to defaultRepo', () => {
  const session = makeSession({ defaultRepo: 'default/repo' });
  const ref = session.resolveRepo(undefined, { cwd: 'C:\\elsewhere' });
  assert.equal(ref.full, 'default/repo');
});

test('resolveRepo explains how to provide a repository', () => {
  const session = makeSession();
  assert.throws(
    () => session.resolveRepo(undefined, { cwd: 'C:\\elsewhere' }),
    /repo is required/,
  );
});

test('rememberRepo updates the defaults', () => {
  const session = makeSession();
  session.rememberRepo('https://ghe.example.com/team/service');
  assert.equal(session.defaults.repo, 'team/service');
  assert.equal(session.defaults.host, 'ghe.example.com');
});

test('cache honors TTL and prefix invalidation', () => {
  const session = makeSession();
  session.setCached('repo:owner/name', { value: 1 }, 60_000);
  session.setCached('repo:other/name', { value: 2 }, 60_000);
  assert.deepEqual(session.getCached('repo:owner/name'), { value: 1 });
  session.invalidateCache('repo:owner/');
  assert.equal(session.getCached('repo:owner/name'), undefined);
  assert.deepEqual(session.getCached('repo:other/name'), { value: 2 });
});

test('journal keeps bounded records', () => {
  const session = makeSession();
  for (let index = 0; index < 205; index += 1) session.record({ operation: `op${index}` });
  assert.equal(session.journal.length, 200);
  assert.equal(session.journal[0].operation, 'op5');
  assert.equal(session.journal.at(-1).operation, 'op204');
});

test('close aborts the lifetime signal and clears bindings', () => {
  const session = makeSession();
  session.bind('C:\\work\\repo', 'owner/repo');
  session.close();
  assert.equal(session.signal.aborted, true);
  assert.equal(session.bindings.size, 0);
});
