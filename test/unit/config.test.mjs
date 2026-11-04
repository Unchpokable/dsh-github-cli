import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, DEFAULTS, resolveConfig } from '../../lib/config.js';

test('resolveConfig fills defaults', () => {
  const config = resolveConfig({});
  assert.equal(config.ghPath, '');
  assert.equal(config.gitPath, 'git');
  assert.equal(config.defaultHost, 'github.com');
  assert.equal(config.maxOutputChars, 80_000);
  assert.equal(config.timeoutMs, 60_000);
  assert.equal(config.longTimeoutMs, 900_000);
  assert.equal(config.requireApproval, true);
  assert.equal(config.allowDestructive, false);
  assert.equal(config.extraction.history, 'preserve');
  assert.equal(config.actions.maxLogLines, 200);
  assert.deepEqual(config.protectedBranches, ['main', 'master']);
});

test('resolveConfig preserves old keys and values', () => {
  const config = resolveConfig({
    ghPath: 'C:\\bin\\gh.exe',
    defaultRepo: 'owner/repo',
    maxOutputChars: 60_000,
    timeoutMs: 30_000,
    requireApproval: false,
  });
  assert.equal(config.ghPath, 'C:\\bin\\gh.exe');
  assert.equal(config.defaultRepo, 'owner/repo');
  assert.equal(config.maxOutputChars, 60_000);
  assert.equal(config.timeoutMs, 30_000);
  assert.equal(config.requireApproval, false);
  assert.equal(config.maxPages, 10);
});

test('resolveConfig merges nested extraction and actions', () => {
  const config = resolveConfig({
    extraction: { history: 'snapshot', cleanupOnFailure: false },
    actions: { maxLogLines: 500 },
  });
  assert.equal(config.extraction.history, 'snapshot');
  assert.equal(config.extraction.cleanupOnFailure, false);
  assert.equal(config.extraction.filterRepoPath, '');
  assert.equal(config.extraction.scratchTtlMs, 3_600_000);
  assert.equal(config.actions.maxLogLines, 500);
  assert.equal(config.actions.allowSecrets, true);
});

test('resolveConfig accepts the approval policy object', () => {
  const config = resolveConfig({ requireApproval: { write: false, destructive: true, admin: false } });
  assert.deepEqual(config.requireApproval, { write: false, destructive: true, admin: false });
});

test('resolveConfig rejects invalid old values with old messages', () => {
  assert.throws(() => resolveConfig({ maxOutputChars: 100 }), /maxOutputChars must be an integer/);
  assert.throws(() => resolveConfig({ timeoutMs: 1000 }), /timeoutMs must be an integer/);
  assert.throws(() => resolveConfig({ ghPath: 1 }), /ghPath must be a string/);
  assert.throws(() => resolveConfig({ requireApproval: 'yes' }), /requireApproval must be a boolean or an object/);
});

test('resolveConfig rejects invalid new values', () => {
  assert.throws(() => resolveConfig({ allowGenericApi: 'all' }), /allowGenericApi must be/);
  assert.throws(() => resolveConfig({ extraction: { history: 'rewrite' } }), /extraction.history must be/);
  assert.throws(() => resolveConfig({ actions: { maxLogLines: 1 } }), /actions.maxLogLines must be/);
  assert.throws(() => resolveConfig({ allowedOrgs: ['a'], deniedOrgs: ['a'] }), /both allowed and denied/);
  assert.throws(() => resolveConfig({ longTimeoutMs: 1000 }), /longTimeoutMs must be an integer/);
});

test('Config schema returns defaults for an empty object', () => {
  const value = Config({});
  assert.equal(value.maxOutputChars, 80_000);
  assert.equal(value.extraction.history, 'preserve');
  assert.equal(value.actions.allowSecrets, true);
  assert.equal(value.requireApproval, true);
});

test('DEFAULTS is frozen and complete', () => {
  assert.equal(Object.isFrozen(DEFAULTS), true);
  assert.equal(Object.isFrozen(DEFAULTS.extraction), true);
  assert.equal(Object.isFrozen(DEFAULTS.actions), true);
});
