/**
 * Authenticated GitHub transport for the dsh-github-cli plugin.
 *
 * Every request goes through the user's own `gh` login, so calls spend the
 * token's 5,000-requests-per-hour REST budget instead of the tiny anonymous
 * one. This module owns executable discovery, managed child processes, and the
 * REST helpers; it never writes to a repository on its own.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const VERSION_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 48 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;

/** Environment overrides that keep gh non-interactive and machine-readable. */
const CHILD_ENV = {
  GH_PROMPT_DISABLED: '1',
  GH_PAGER: 'cat',
  GH_NO_UPDATE_NOTIFIER: '1',
  CLICOLOR: '0',
  NO_COLOR: '1',
  GIT_TERMINAL_PROMPT: '0',
};

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

/** First non-blank line of a diagnostic stream. */
function firstLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
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

/** Readable command name for diagnostics, without header and flag values. */
function commandLabel(args) {
  if (args[0] === 'api') {
    const endpoint = args[args.length - 1];
    const methodIndex = args.indexOf('--method');
    const method = methodIndex >= 0 ? args[methodIndex + 1] : 'GET';
    return `api ${method} ${endpoint}`;
  }
  if (args[0] === 'auth') return 'auth status';
  const positional = args.filter((arg) => !arg.startsWith('-'));
  return positional.slice(0, 2).join(' ');
}

/**
 * Translate a non-zero gh exit into an actionable error.
 *
 * @param {{code: number|null, stdout: string, stderr: string}} result - child outcome.
 * @param {readonly string[]} args - argv for context.
 * @returns {Error}
 */
export function githubError(result, args) {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  const lower = detail.toLowerCase();
  const command = commandLabel(args) || 'gh';
  const line = firstLine(detail);

  if (lower.includes('bad credentials') || lower.includes('http 401') || lower.includes('gh auth login')) {
    return new Error(`GitHub authentication failed (${command}): ${line}. Run \`gh auth login\`, or set GH_TOKEN for an account that can read this repository.`);
  }
  if (lower.includes('rate limit')) {
    return new Error(`GitHub API rate limit reached (${command}): ${line}. Check the authenticated account and remaining quota with github_status.`);
  }
  if (lower.includes('http 404') || /^not found$/i.test(line)) {
    return new Error(`GitHub returned 404 for ${command}: ${line}. Check the repository name, ref, path, or pull request number; private repositories need the repo token scope.`);
  }
  if (detail.length === 0) {
    return new Error(`gh ${command} failed with exit code ${result.code}.`);
  }
  return new Error(`gh ${command} failed: ${detail.slice(0, 2000)}`);
}

/**
 * Run gh and require a zero exit code.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {readonly string[]} args - gh argv.
 * @param {object} [options] - stdin, abort signal, byte caps.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function ghCommand(config, args, options = {}) {
  const executable = await resolveGh(config);
  const result = await run(executable.path, args, {
    input: options.stdin,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
    maxStdoutBytes: options.maxStdoutBytes,
  });
  if (result.code !== 0) throw githubError(result, args);
  return result;
}

/**
 * Call one REST endpoint and return the raw response body.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {string} endpoint - REST path, without the API host.
 * @param {object} [options] - method, JSON body, Accept header, abort signal.
 * @returns {Promise<string>}
 */
export async function apiText(config, endpoint, options = {}) {
  const args = ['api', '--method', options.method ?? 'GET'];
  args.push('-H', `Accept: ${options.accept ?? 'application/vnd.github+json'}`);
  args.push('-H', 'X-GitHub-Api-Version: 2022-11-28');
  if (options.input !== undefined) args.push('--input', '-');
  args.push(endpoint);

  const result = await ghCommand(config, args, {
    stdin: options.input === undefined ? undefined : JSON.stringify(options.input),
    signal: options.signal,
    maxStdoutBytes: options.maxStdoutBytes,
  });
  return result.stdout;
}

/**
 * Call one REST endpoint and parse its JSON response.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {string} endpoint - REST path.
 * @param {object} [options] - same as {@link apiText}.
 * @returns {Promise<any>}
 */
export async function apiJson(config, endpoint, options = {}) {
  const text = (await apiText(config, endpoint, options)).trim();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GitHub returned a response this tool could not parse (${options.method ?? 'GET'} ${endpoint}).`);
  }
}

/**
 * Read a paged REST list, requesting pages explicitly so one huge collection
 * cannot run away with the call budget.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {string} endpoint - collection path; `?` is allowed.
 * @param {{maxPages?: number, signal?: AbortSignal}} [options] - page cap and cancellation.
 * @returns {Promise<{items: any[], complete: boolean, pages: number}>}
 */
export async function apiList(config, endpoint, options = {}) {
  const maxPages = options.maxPages ?? 10;
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const pageItems = await apiJson(config, `${endpoint}${separator}per_page=100&page=${page}`, {
      signal: options.signal,
    });
    if (!Array.isArray(pageItems)) {
      throw new Error(`GitHub did not return a list for ${endpoint}.`);
    }
    items.push(...pageItems);
    if (pageItems.length < 100) return { items, complete: true, pages: page };
  }
  return { items, complete: false, pages: maxPages };
}

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/**
 * Normalize a repository reference.
 *
 * @param {string|undefined} input - `owner/name`, a GitHub URL, or empty to use the configured default.
 * @param {{defaultRepo?: string}} config - plugin configuration.
 * @returns {string} `owner/name`
 */
export function parseRepo(input, config = {}) {
  const fallback = typeof config.defaultRepo === 'string' ? config.defaultRepo.trim() : '';
  const raw = typeof input === 'string' && input.trim().length > 0 ? input.trim() : fallback;
  if (raw.length === 0) {
    throw new Error('repo is required: pass "owner/name", or set defaultRepo in the plugin config.');
  }
  const value = raw
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!REPO_PATTERN.test(value)) {
    throw new Error(`repo must look like "owner/name", got "${raw}".`);
  }
  return value;
}

/**
 * Normalize a pull request reference.
 *
 * @param {string|number|undefined} input - PR number or github.com pull URL.
 * @returns {{number: number, repo?: string}}
 */
export function parsePull(input) {
  if (input === undefined || input === null || String(input).trim().length === 0) {
    throw new Error('pr is required: pass the pull request number or its GitHub URL.');
  }
  const text = String(input).trim();
  const fromUrl = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(text);
  if (fromUrl) {
    return { number: Number(fromUrl[3]), repo: `${fromUrl[1]}/${fromUrl[2]}` };
  }
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    if (number > 0) return { number };
  }
  throw new Error(`pr must be a pull request number or a github.com pull request URL, got "${text}".`);
}

/**
 * Resolve the repository for one call: explicit argument, then a repository
 * taken from a PR URL, then the configured default.
 *
 * @param {string|undefined} input - explicit repository argument.
 * @param {object} config - plugin configuration.
 * @param {string} [fromPull] - repository parsed out of a PR URL.
 * @returns {string}
 */
export function resolveRepo(input, config, fromPull) {
  return parseRepo(input, { ...config, defaultRepo: fromPull ?? config.defaultRepo ?? '' });
}

/** Short commit form used in labels. */
export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : '';
}

/** Human-readable byte size. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** ISO timestamp for an epoch-seconds value, or null. */
export function isoSeconds(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}
