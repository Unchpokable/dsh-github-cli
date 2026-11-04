/**
 * Managed GitHub CLI processes and executable discovery.
 *
 * This is the compatibility core extracted from the original `gh.js`: it keeps
 * the same argv-without-shell contract, bounded output, cached discovery, and
 * the user's own gh login. Local git processes are intentionally elsewhere:
 * they must go through the DSH subprocess and sandbox services so writes obey
 * the session's file policy.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { firstLine, githubError } from '../errors.js';

const VERSION_TIMEOUT_MS = 15_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_STDOUT_BYTES = 48 * 1024 * 1024;
export const MAX_STDERR_BYTES = 1024 * 1024;

/** Environment overrides that keep gh non-interactive and machine-readable. */
export const CHILD_ENV = Object.freeze({
  GH_PROMPT_DISABLED: '1',
  GH_PAGER: 'cat',
  GH_NO_UPDATE_NOTIFIER: '1',
  CLICOLOR: '0',
  NO_COLOR: '1',
  GIT_TERMINAL_PROMPT: '0',
});

/** Absolute locations where the installer of each platform usually lands. */
function installLocations() {
  if (platform() === 'win32') {
    const locations = [];
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const localAppData = process.env.LOCALAPPDATA;
    const programData = process.env.ProgramData;
    if (programFiles) locations.push(join(programFiles, 'GitHub CLI', 'gh.exe'));
    if (programFilesX86) locations.push(join(programFilesX86, 'GitHub CLI', 'gh.exe'));
    if (localAppData) {
      locations.push(
        join(localAppData, 'GitHubCLI', 'gh.exe'),
        join(localAppData, 'Programs', 'gh', 'gh.exe'),
        join(localAppData, 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
      );
    }
    if (programData) locations.push(join(programData, 'chocolatey', 'bin', 'gh.exe'));
    if (process.env.SCOOP) locations.push(join(process.env.SCOOP, 'shims', 'gh.exe'));
    return locations;
  }
  const home = homedir();
  return [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
    '/snap/bin/gh',
    join(home, '.local', 'bin', 'gh'),
    join(home, 'bin', 'gh'),
  ];
}

function abortReason() {
  const error = new Error('The GitHub request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Run one child process to completion with bounded output.
 *
 * @param {string} file - executable path or bare command name.
 * @param {readonly string[]} args - argv, passed without a shell.
 * @param {object} [options] - stdin text, cwd, environment, timeout, abort signal, byte caps.
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string}>}
 */
export function run(file, args, options = {}) {
  const {
    input,
    cwd = homedir(),
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    maxStdoutBytes = MAX_STDOUT_BYTES,
    maxStderrBytes = MAX_STDERR_BYTES,
  } = options;

  if (signal?.aborted) return Promise.reject(abortReason());

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: { ...env, ...CHILD_ENV },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        try {
          child.kill();
        } catch {
          // The process may already be gone; the rejection below is the result.
        }
        reject(error);
        return;
      }
      resolve(value);
    };

    const timer = setTimeout(() => {
      const command = args.filter((arg) => !arg.startsWith('-')).slice(0, 2).join(' ');
      settle(new Error(`GitHub CLI did not finish within ${Math.round(timeoutMs / 1000)}s: gh ${command}`));
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => settle(abortReason());
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        settle(new Error('GitHub CLI produced more output than this tool accepts. Narrow the request, for example with paths or a smaller max_chars.'));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxStderrBytes) stderr.push(chunk);
    });

    child.on('error', (error) => settle(error));
    child.on('close', (code, closeSignal) => {
      settle(null, {
        code,
        signal: closeSignal ?? null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });

    child.stdin.on('error', () => {
      // gh may exit before reading stdin; its exit code carries the real result.
    });
    child.stdin.end(input ?? undefined);
  });
}

/** Cached discovery result, keyed by the inputs that decide it. */
let discovery = null;

/**
 * Locate a usable gh executable: the configured path, then PATH, then the
 * platform's standard install locations.
 *
 * @param {{ghPath?: string}} [config] - plugin configuration.
 * @returns {Promise<{path: string, version: string, source: string}>}
 */
export async function resolveGh(config = {}) {
  const explicit = typeof config.ghPath === 'string' ? config.ghPath.trim() : '';
  const key = `${explicit}\n${process.env.PATH ?? ''}\n${platform()}`;
  if (discovery?.key === key) {
    try {
      return await discovery.value;
    } catch {
      // A failed discovery is retried below; gh may have been installed since.
    }
  }

  const promise = discoverGh(explicit);
  discovery = { key, value: promise };
  try {
    return await promise;
  } catch (error) {
    if (discovery?.value === promise) discovery = null;
    throw error;
  }
}

async function discoverGh(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push({ path: explicitPath, source: 'ghPath config' });
  candidates.push({ path: 'gh', source: 'PATH' });
  for (const location of installLocations()) {
    if (existsSync(location)) candidates.push({ path: location, source: 'standard install location' });
  }

  const attempts = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    try {
      const result = await run(candidate.path, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
      if (result.code !== 0) {
        attempts.push(`${candidate.path}: ${firstLine(result.stderr) || `exit ${result.code}`}`);
        continue;
      }
      return {
        path: candidate.path,
        version: /gh version (\S+)/.exec(result.stdout)?.[1] ?? 'unknown',
        source: candidate.source,
      };
    } catch (error) {
      attempts.push(`${candidate.path}: ${error?.code === 'ENOENT' ? 'not found' : error.message}`);
    }
  }

  const tried = attempts.length > 0 ? ` Tried: ${attempts.join('; ')}.` : '';
  throw new Error(
    `GitHub CLI (gh) was not found.${tried} Install it from https://cli.github.com, put it on PATH, or set "ghPath" in this plugin's config.`,
  );
}

/**
 * Run gh and require a zero exit code.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {readonly string[]} args - gh argv.
 * @param {object} [options] - stdin, abort signal, byte caps, cwd.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function ghCommand(config, args, options = {}) {
  const result = await ghRun(config, args, options);
  if (result.code !== 0) throw githubError(result, args);
  return result;
}

/**
 * Run gh and return its outcome without translating a non-zero exit.
 *
 * Callers that need HTTP status or headers use this and classify the result
 * themselves; ordinary callers use {@link ghCommand}.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {readonly string[]} args - gh argv.
 * @param {object} [options] - stdin, abort signal, byte caps, cwd.
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string}>}
 */
export async function ghRun(config, args, options = {}) {
  const executable = await resolveGh(config);
  return run(executable.path, args, {
    input: options.stdin,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
  });
}

/** Reset the cached gh discovery result (tests and explicit re-probes). */
export function resetGhDiscovery() {
  discovery = null;
}
