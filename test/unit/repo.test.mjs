import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePull, parseRemote, parseRepo, parseRepoRef, resolveRepo } from '../../lib/repo.js';

test('parseRepoRef accepts owner/name', () => {
  const ref = parseRepoRef('owner/repo');
  assert.equal(ref.host, 'github.com');
  assert.equal(ref.owner, 'owner');
  assert.equal(ref.name, 'repo');
  assert.equal(ref.full, 'owner/repo');
});

test('parseRepoRef accepts GitHub URLs and strips .git', () => {
  const ref = parseRepoRef('https://github.com/owner/repo.git');
  assert.equal(ref.full, 'owner/repo');
  assert.equal(ref.host, 'github.com');
});

test('parseRepoRef preserves a GitHub Enterprise host', () => {
  const ref = parseRepoRef('https://ghe.example.com/team/service.git');
  assert.equal(ref.host, 'ghe.example.com');
  assert.equal(ref.full, 'team/service');
});

test('parseRepoRef accepts an SSH remote', () => {
  const ref = parseRepoRef('git@github.com:owner/repo.git');
  assert.equal(ref.host, 'github.com');
  assert.equal(ref.full, 'owner/repo');
});

test('parseRepo keeps the old defaultRepo behavior', () => {
  assert.equal(parseRepo(undefined, { defaultRepo: 'owner/repo' }), 'owner/repo');
  assert.equal(parseRepo('https://github.com/owner/repo', {}), 'owner/repo');
  assert.throws(() => parseRepo(undefined, {}), /repo is required/);
  assert.throws(() => parseRepo('not a repo', {}), /repo must look like/);
});

test('resolveRepo prefers the PR repository over the default', () => {
  assert.equal(resolveRepo(undefined, { defaultRepo: 'default/repo' }, 'from/pr'), 'from/pr');
  assert.equal(resolveRepo(undefined, { defaultRepo: 'default/repo' }), 'default/repo');
  assert.equal(resolveRepo('explicit/repo', { defaultRepo: 'default/repo' }), 'explicit/repo');
});

test('parsePull accepts a number and a pull URL', () => {
  assert.deepEqual(parsePull('42'), { number: 42 });
  const fromUrl = parsePull('https://github.com/owner/repo/pull/7');
  assert.equal(fromUrl.number, 7);
  assert.equal(fromUrl.repo, 'owner/repo');
  assert.equal(fromUrl.host, 'github.com');
  assert.throws(() => parsePull('abc'), /pull request number/);
});

test('parseRemote handles scp, ssh, and https remotes', () => {
  assert.equal(parseRemote('git@github.com:owner/repo.git').full, 'owner/repo');
  assert.equal(parseRemote('ssh://git@github.com/owner/repo.git').full, 'owner/repo');
  assert.equal(parseRemote('https://github.com/owner/repo.git').full, 'owner/repo');
  assert.equal(parseRemote('https://ghe.example.com/team/service').host, 'ghe.example.com');
  assert.equal(parseRemote('not a remote'), null);
});
