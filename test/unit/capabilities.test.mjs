import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGhVersion,
  parseGitVersion,
  probeCapabilities,
  probeFilterRepo,
  probeGit,
  probeLfs,
  versionAtLeast,
} from '../../lib/capabilities.js';
import { resolveConfig } from '../../lib/config.js';

const config = resolveConfig({});

function fakeRunner(overrides = {}) {
  return async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    if (key in overrides) return overrides[key];
    if (key === 'git --version') return { code: 0, stdout: 'git version 2.51.2.windows.1\n', stderr: '' };
    if (key === 'git filter-repo --version') return { code: 0, stdout: '2.47.0\n', stderr: '' };
    if (key === 'git lfs version') return { code: 0, stdout: 'git-lfs/3.6.1 (GitHub.com)\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'not found' };
  };
}

test('parseGitVersion and parseGhVersion produce comparable records', () => {
  assert.deepEqual(parseGitVersion('git version 2.51.2.windows.1'), { raw: '2.51.2.windows.1', major: 2, minor: 51, patch: 2 });
  assert.equal(parseGhVersion('gh version 2.80.0 (2025-01-01)').minor, 80);
  assert.equal(parseGitVersion('not git'), null);
});

test('versionAtLeast compares numeric segments', () => {
  assert.equal(versionAtLeast(parseGhVersion('gh version 2.80.0'), '2.0.0'), true);
  assert.equal(versionAtLeast(parseGhVersion('gh version 1.9.9'), '2.0.0'), false);
  assert.equal(versionAtLeast(parseGhVersion('gh version 2.0.0'), '2.0.0'), true);
});

test('probeGit and probeLfs read version output', async () => {
  const git = await probeGit(config, { run: fakeRunner() });
  assert.equal(git.found, true);
  assert.equal(git.version.major, 2);
  const lfs = await probeLfs(config, { run: fakeRunner() });
  assert.equal(lfs.found, true);
  assert.equal(lfs.version, '3.6.1');
});

test('probeFilterRepo uses the git subcommand when no path is configured', async () => {
  const result = await probeFilterRepo(config, { run: fakeRunner() });
  assert.equal(result.found, true);
  assert.equal(result.path, 'git');
});

test('probeCapabilities reports all capabilities and services', async () => {
  const ctx = {
    get(name) {
      return ['subprocess', 'fs', 'approval'].includes(name) ? { name } : undefined;
    },
  };
  const value = await probeCapabilities(config, {
    ctx,
    gh: { found: true, path: 'gh', version: '2.80.0', parsed: parseGhVersion('gh version 2.80.0'), source: 'PATH', versionOk: true },
    run: fakeRunner(),
  });
  assert.equal(value.gh.found, true);
  assert.equal(value.git.found, true);
  assert.equal(value.filterRepo.found, true);
  assert.equal(value.lfs.found, true);
  assert.equal(value.services.subprocess, true);
  assert.equal(value.services.fs, true);
  assert.equal(value.services.jobs, false);
});
