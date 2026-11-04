/**
 * One session's GitHub context.
 *
 * The session remembers which account is active, what the local toolchain can
 * do, which local checkout maps to which repository, and what happened recently.
 * Tools resolve a repository through it instead of asking for `repo` on every
 * call.
 */

import { run } from './gh/exec.js';
import { readAuthStatus } from './gh/auth.js';
import { probeCapabilities } from './capabilities.js';
import { parseRemote, parseRepoRef } from './repo.js';

const MAX_JOURNAL = 200;

function normalizeCwd(value) {
  return typeof value === 'string' && value.length > 0 ? value : process.cwd();
}

function nearestBinding(bindings, cwd) {
  let best = null;
  for (const [path, binding] of bindings) {
    if (cwd === path || cwd.startsWith(`${path}\\`) || cwd.startsWith(`${path}/`)) {
      if (best === null || path.length > best.path.length) best = { path, binding };
    }
  }
  return best?.binding ?? null;
}

/** A lazy, per-activation GitHub session. */
export class GitHubSession {
  /**
   * @param {object} config - resolved plugin configuration.
   * @param {object} [ctx] - DSH plugin context, when available.
   */
  constructor(config, ctx = null) {
    this.config = config;
    this.ctx = ctx;
    this.auth = null;
    this.capabilities = null;
    this.cwd = null;
    this.agent = null;
    this.bindings = new Map();
    this.defaults = {
      host: config.defaultHost,
      repo: config.defaultRepo || null,
      owner: config.defaultOwner || null,
      org: config.defaultOrg || null,
    };
    this.cache = new Map();
    this.journal = [];
    this.initialized = false;
    this.initializing = null;
    this.lifetime = new AbortController();
  }

  /** The abort signal for work owned by this session. */
  get signal() {
    return this.lifetime.signal;
  }

  /**
   * Initialize auth, capabilities, cwd, and the current binding once.
   *
   * @param {object} [exec] - tool execution context with an agent.
   * @returns {Promise<GitHubSession>}
   */
  async init(exec = {}) {
    if (this.initialized) return this;
    if (this.initializing !== null) {
      await this.initializing;
      return this;
    }
    this.agent = exec.agent ?? this.agent;
    const signal = exec.signal ? AbortSignal.any([this.lifetime.signal, exec.signal]) : this.lifetime.signal;
    this.initializing = (async () => {
      const [auth, capabilities] = await Promise.all([
        readAuthStatus(this.config, signal),
        probeCapabilities(this.config, { ctx: this.ctx, signal }),
      ]);
      this.auth = auth;
      this.capabilities = capabilities;
      this.cwd = await this.currentDirectory(exec, signal);
      this.initialized = true;
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
    return this;
  }

  /**
   * Resolve the session's current directory, preferring the DSH working
   * directory service over the host process cwd.
   *
   * @param {object} [exec] - tool execution context.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>}
   */
  async currentDirectory(exec = {}, signal) {
    const service = this.ctx?.get?.('workingDirectory');
    if (service && exec.agent) {
      try {
        const value = await service.ensure(exec.agent, signal);
        if (typeof value === 'string' && value.length > 0) return value;
      } catch {
        // Fall through to the process cwd; status remains useful without the service.
      }
    }
    return process.cwd();
  }

  /**
   * Read the git repository that contains `cwd` and bind it.
   *
   * @param {string} [cwd] - directory to inspect.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object|null>} binding.
   */
  async detectBinding(cwd = this.cwd ?? process.cwd(), signal) {
    const directory = normalizeCwd(cwd);
    try {
      const root = await run(this.config.gitPath, ['-C', directory, 'rev-parse', '--show-toplevel'], {
        timeoutMs: 10_000,
        signal,
      });
      if (root.code !== 0) return null;
      const rootPath = root.stdout.replace(/\r?\n$/, '').trim();
      if (rootPath.length === 0) return null;

      const remotes = await run(this.config.gitPath, ['-C', rootPath, 'remote', '-v'], {
        timeoutMs: 10_000,
        signal,
      });
      if (remotes.code !== 0) return null;

      const parsed = [];
      for (const line of remotes.stdout.split(/\r?\n/)) {
        const match = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
        if (!match || match[3] !== 'fetch') continue;
        const ref = parseRemote(match[2]);
        if (ref !== null) parsed.push({ remote: match[1], ...ref });
      }
      if (parsed.length === 0) return null;

      const chosen = parsed.find((entry) => entry.remote === 'origin')
        ?? parsed.find((entry) => entry.remote === 'upstream')
        ?? parsed[0];

      const branch = await run(this.config.gitPath, ['-C', rootPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        timeoutMs: 10_000,
        signal,
      });

      const binding = {
        path: rootPath,
        repo: chosen.full,
        host: chosen.host,
        remote: chosen.remote,
        branch: branch.code === 0 ? branch.stdout.trim() : null,
      };
      this.bindings.set(binding.path, binding);
      return binding;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a repository reference.
   *
   * @param {string|undefined} input - explicit repo/URL.
   * @param {object} [options] - cwd, repository taken from a PR URL, host hint.
   * @returns {{host: string, full: string, owner: string, name: string}}
   */
  resolveRepo(input, options = {}) {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (raw.length > 0) return parseRepoRef(raw, options.host ?? this.defaults.host);

    if (typeof options.fromPull === 'string' && options.fromPull.trim().length > 0) {
      return parseRepoRef(options.fromPull, options.host ?? this.defaults.host);
    }

    const cwd = normalizeCwd(options.cwd ?? this.cwd ?? process.cwd());
    const binding = nearestBinding(this.bindings, cwd);
    if (binding !== null) {
      const ref = parseRepoRef(binding.repo, binding.host);
      return ref;
    }

    if (this.defaults.repo) return parseRepoRef(this.defaults.repo, this.defaults.host);

    throw new Error(
      'repo is required: pass "owner/name", run github_workspace action=bind, or set defaultRepo in the plugin config.',
    );
  }

  /** Remember a repository for subsequent calls. */
  rememberRepo(input) {
    const ref = parseRepoRef(input, this.defaults.host);
    this.defaults.repo = ref.full;
    this.defaults.host = ref.host;
    return ref;
  }

  /** Bind an explicit path to a repository. */
  bind(path, repo, remote = 'origin') {
    const ref = parseRepoRef(repo, this.defaults.host);
    const binding = { path, repo: ref.full, host: ref.host, remote, branch: null };
    this.bindings.set(path, binding);
    return binding;
  }

  /** TTL cache used for read-only metadata. */
  getCached(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Store a read-only value with a TTL. */
  setCached(key, value, ttlMs = 60_000) {
    this.cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  /** Drop cached values whose key starts with `prefix`. */
  invalidateCache(prefix = '') {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** Append an operation record to the bounded journal. */
  record(entry) {
    const record = { at: new Date().toISOString(), ...entry };
    this.journal.push(record);
    if (this.journal.length > MAX_JOURNAL) this.journal.shift();
    return record;
  }

  /**
   * A compact status snapshot for `github_status`.
   *
   * @param {object} [exec] - tool execution context.
   * @returns {Promise<object>}
   */
  async status(exec = {}) {
    await this.init(exec);
    if (this.cwd) await this.detectBinding(this.cwd, exec.signal);
    return {
      host: this.auth?.host ?? this.defaults.host,
      account: this.auth?.account ?? null,
      authenticated: this.auth?.authenticated ?? false,
      scopes: this.auth?.scopes ?? [],
      rate_limit: this.auth?.rate_limit ?? null,
      capabilities: this.capabilities,
      cwd: this.cwd,
      bindings: [...this.bindings.values()],
      defaults: { ...this.defaults },
      journal: this.journal.slice(-10),
    };
  }

  /** Abort in-flight work and release references. */
  close() {
    this.lifetime.abort(new Error('GitHub session closed'));
    this.cache.clear();
    this.bindings.clear();
  }
}
