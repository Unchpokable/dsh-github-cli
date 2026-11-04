/**
 * Capability probes.
 *
 * A GitHub operation can depend on more than gh: local git, git-filter-repo,
 * Git LFS, and the DSH services that keep local writes inside the session's
 * sandbox. The status tool reports what is actually available instead of
 * failing later with a spawn error.
 */

import { platform } from 'node:os';
import { run, resolveGh } from './gh/exec.js';

const PROBE_TIMEOUT_MS = 15_000;

function servicePresent(ctx, name) {
  if (!ctx) return false;
  try {
    return ctx.get(name) !== undefined;
  } catch {
    return false;
  }
}

/** Parse `git version 2.51.2.windows.1` into a comparable record. */
export function parseGitVersion(output) {
  const match = /git version (\S+)/i.exec(String(output ?? ''));
  if (!match) return null;
  const numbers = match[1].split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10));
  return {
    raw: match[1],
    major: Number.isFinite(numbers[0]) ? numbers[0] : 0,
    minor: Number.isFinite(numbers[1]) ? numbers[1] : 0,
    patch: Number.isFinite(numbers[2]) ? numbers[2] : 0,
  };
}

/** Parse `gh version 2.80.0 (2025-...)`. */
export function parseGhVersion(output) {
  const match = /gh version (\S+)/i.exec(String(output ?? ''));
  if (!match) return null;
  const numbers = match[1].split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10));
  return {
    raw: match[1],
    major: Number.isFinite(numbers[0]) ? numbers[0] : 0,
    minor: Number.isFinite(numbers[1]) ? numbers[1] : 0,
    patch: Number.isFinite(numbers[2]) ? numbers[2] : 0,
  };
}

/** True when `version` is at least `minimum` (each as `major.minor.patch`). */
export function versionAtLeast(version, minimum) {
  if (version === null || version === undefined) return false;
  const [major, minor, patch] = minimum.split('.').map((part) => Number.parseInt(part, 10));
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return version.patch >= patch;
}

/**
 * Probe local git and its optional extensions.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} [options] - signal and an injectable command runner.
 * @returns {Promise<object>} git capability facts; never throws for a missing tool.
 */
export async function probeGit(config, options = {}) {
  const runner = options.run ?? run;
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  try {
    const result = await runner(config.gitPath ?? 'git', ['--version'], { timeoutMs, signal });
    if (result.code !== 0) {
      return { found: false, path: config.gitPath ?? 'git', version: null, error: result.stderr.trim() || `exit ${result.code}` };
    }
    return {
      found: true,
      path: config.gitPath ?? 'git',
      version: parseGitVersion(result.stdout),
      raw: result.stdout.trim(),
    };
  } catch (error) {
    return { found: false, path: config.gitPath ?? 'git', version: null, error: error.message };
  }
}

/**
 * Probe git-filter-repo. A configured path is executed directly; otherwise the
 * `git filter-repo` subcommand is tried, which is how the tool is normally
 * installed.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} [options] - signal and runner.
 * @returns {Promise<{found: boolean, path: string, error?: string}>}
 */
export async function probeFilterRepo(config, options = {}) {
  const runner = options.run ?? run;
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const configured = typeof config.extraction?.filterRepoPath === 'string'
    ? config.extraction.filterRepoPath.trim()
    : '';
  const path = configured.length > 0 ? configured : (config.gitPath ?? 'git');
  const args = configured.length > 0 ? ['--version'] : ['filter-repo', '--version'];

  try {
    const result = await runner(path, args, { timeoutMs, signal });
    return result.code === 0
      ? { found: true, path }
      : { found: false, path, error: result.stderr.trim() || `exit ${result.code}` };
  } catch (error) {
    return { found: false, path, error: error.message };
  }
}

/**
 * Probe Git LFS.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} [options] - signal and runner.
 * @returns {Promise<{found: boolean, version: string|null, error?: string}>}
 */
export async function probeLfs(config, options = {}) {
  const runner = options.run ?? run;
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const result = await runner(config.gitPath ?? 'git', ['lfs', 'version'], { timeoutMs, signal });
    const version = /git-lfs\/(\S+)/i.exec(result.stdout)?.[1] ?? null;
    return result.code === 0
      ? { found: true, version }
      : { found: false, version: null, error: result.stderr.trim() || `exit ${result.code}` };
  } catch (error) {
    return { found: false, version: null, error: error.message };
  }
}

/**
 * Probe every capability in parallel where possible.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} [options] - signal, DSH context, injectable runner.
 * @returns {Promise<object>} capability record.
 */
export async function probeCapabilities(config, options = {}) {
  const ctx = options.ctx;
  const signal = options.signal;
  const runner = options.run ?? run;

  const ghPromise = options.gh
    ? Promise.resolve(options.gh)
    : (async () => {
      try {
        const executable = await resolveGh(config);
        const version = parseGhVersion(`gh version ${executable.version}`);
        return {
          found: true,
          path: executable.path,
          version: executable.version,
          parsed: version,
          source: executable.source,
          versionOk: versionAtLeast(version, '2.0.0'),
        };
      } catch (error) {
        return { found: false, error: error.message, version: null };
      }
    })();

  const [gh, git, filterRepo, lfs] = await Promise.all([
    ghPromise,
    probeGit(config, { signal, run: runner }),
    probeFilterRepo(config, { signal, run: runner }),
    probeLfs(config, { signal, run: runner }),
  ]);

  return {
    gh,
    git,
    filterRepo,
    lfs,
    services: {
      subprocess: servicePresent(ctx, 'subprocess'),
      sandbox: servicePresent(ctx, 'sandbox'),
      sandboxPolicy: servicePresent(ctx, 'sandboxPolicy'),
      fs: servicePresent(ctx, 'fs'),
      workingDirectory: servicePresent(ctx, 'workingDirectory'),
      jobs: servicePresent(ctx, 'jobs'),
      commands: servicePresent(ctx, 'commands'),
      approval: servicePresent(ctx, 'approval'),
    },
    platform: platform(),
    node: process.version,
    cwd: process.cwd(),
  };
}
