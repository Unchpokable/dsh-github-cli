import test from 'node:test';
import assert from 'node:assert/strict';
import { isInside, runGit } from '../../lib/git/exec.js';
import { resolveConfig } from '../../lib/config.js';

const config = resolveConfig({});

function fakeCtx({ exitCode = 0, stdout = '', stderr = '', confined = true } = {}) {
  const spawns = [];
  const subprocess = {
    async resolveExecutable(name) {
      return name;
    },
    spawn(request) {
      spawns.push(request);
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
        },
        terminate() {},
      };
    },
  };
  const sandboxPolicy = { resolve: () => ({ mode: 'workspace-write' }) };
  const sandbox = {
    async confine(command) {
      return { argv: confined ? ['confined', ...command] : command };
    },
  };
  const services = { subprocess, sandboxPolicy, sandbox };
  return {
    spawns,
    ctx: {
      get(name) {
        return services[name];
      },
    },
  };
}

test('runGit spawns through subprocess and returns stdout', async () => {
  const { ctx, spawns } = fakeCtx({ stdout: 'git version 2.0.0\n' });
  const result = await runGit(ctx, config, ['--version'], { cwd: 'C:\\work' });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'git version 2.0.0\n');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].argv[0], 'confined');
  assert.deepEqual(spawns[0].argv.slice(1), ['git', '--version']);
});

test('runGit reports a non-zero exit with a git error', async () => {
  const { ctx } = fakeCtx({ exitCode: 1, stderr: 'fatal: not a git repository' });
  await assert.rejects(
    runGit(ctx, config, ['status'], {}),
    (error) => error.code === 'git' && /not a git repository/.test(error.message),
  );
});

test('runGit allows explicitly accepted exit codes', async () => {
  const { ctx } = fakeCtx({ exitCode: 1, stderr: 'nothing to commit' });
  const result = await runGit(ctx, config, ['diff', '--quiet'], { allowCodes: [0, 1] });
  assert.equal(result.code, 1);
});

test('runGit fails clearly when subprocess is not mounted', async () => {
  await assert.rejects(
    runGit({ get: () => undefined }, config, ['status'], {}),
    (error) => error.code === 'unsupported',
  );
});

test('isInside keeps paths inside a root', () => {
  assert.equal(isInside('C:\\work', 'C:\\work\\repo'), true);
  assert.equal(isInside('C:\\work', 'C:\\work'), true);
  assert.equal(isInside('C:\\work', 'C:\\work-other\\repo'), false);
  assert.equal(isInside('/work', '/work/repo'), true);
  assert.equal(isInside('/work', '/work-other/repo'), false);
});
