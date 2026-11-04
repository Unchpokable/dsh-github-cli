/**
 * Repository and pull request references.
 *
 * A reference may be `owner/name`, a GitHub URL on any host, or a git remote
 * (SSH or HTTPS). Internally every reference carries a host so GitHub Enterprise
 * and github.com never collide.
 */

const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d+)?$/;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const FULL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/** Normalize a host: strip a scheme, trailing slash, and a path. */
export function normalizeHost(input, fallback = 'github.com') {
  const raw = typeof input === 'string' ? input.trim() : '';
  const value = raw.length > 0 ? raw : fallback;
  const stripped = value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!HOST_PATTERN.test(stripped)) {
    throw new Error(`host must look like "github.com" or "ghe.example.com", got "${value}".`);
  }
  return stripped.toLowerCase();
}

/**
 * Parse a repository reference without a default.
 *
 * @param {string} input - `owner/name`, a GitHub URL, or a git remote.
 * @param {string} [defaultHost] - host for a bare `owner/name`.
 * @returns {{host: string, owner: string, name: string, full: string}}
 */
export function parseRepoRef(input, defaultHost = 'github.com') {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) throw new Error('repo is required: pass "owner/name" or a GitHub URL.');

  const remote = parseRemote(raw);
  if (remote !== null) return remote;

  const url = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(raw);
  if (url) {
    const host = normalizeHost(url[1], defaultHost);
    const owner = url[2];
    const name = url[3].replace(/\.git$/i, '');
    return validateRepoRef(host, owner, name, raw);
  }

  const value = raw.replace(/\.git$/i, '').replace(/\/+$/, '');
  const slash = value.indexOf('/');
  if (slash > 0) {
    const owner = value.slice(0, slash);
    const name = value.slice(slash + 1);
    if (!name.includes('/')) return validateRepoRef(normalizeHost(defaultHost), owner, name, raw);
  }
  throw new Error(`repo must look like "owner/name", got "${raw}".`);
}

/**
 * Normalize a repository reference to `owner/name`, preserving the old
 * `parseRepo` contract used by the existing tools.
 *
 * @param {string|undefined} input - `owner/name`, URL, or empty for default.
 * @param {{defaultRepo?: string, defaultHost?: string}} [config] - plugin config.
 * @returns {string} `owner/name`
 */
export function parseRepo(input, config = {}) {
  const fallback = typeof config.defaultRepo === 'string' ? config.defaultRepo.trim() : '';
  const raw = typeof input === 'string' && input.trim().length > 0 ? input.trim() : fallback;
  if (raw.length === 0) {
    throw new Error('repo is required: pass "owner/name", or set defaultRepo in the plugin config.');
  }
  const ref = parseRepoRef(raw, config.defaultHost ?? 'github.com');
  return ref.full;
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

/**
 * Normalize a pull request reference.
 *
 * @param {string|number|undefined} input - PR number or GitHub pull URL.
 * @returns {{number: number, repo?: string, host?: string}}
 */
export function parsePull(input) {
  if (input === undefined || input === null || String(input).trim().length === 0) {
    throw new Error('pr is required: pass the pull request number or its GitHub URL.');
  }
  const text = String(input).trim();
  const fromUrl = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(text);
  if (fromUrl) {
    return {
      number: Number(fromUrl[4]),
      repo: `${fromUrl[2]}/${fromUrl[3]}`,
      host: normalizeHost(fromUrl[1]),
    };
  }
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    if (number > 0) return { number };
  }
  throw new Error(`pr must be a pull request number or a github.com pull request URL, got "${text}".`);
}

/**
 * Parse a git remote URL into a repository reference, or return null when it
 * does not look like a GitHub remote.
 *
 * @param {string} input - `origin` URL from `git remote -v`.
 * @returns {{host: string, owner: string, name: string, full: string}|null}
 */
export function parseRemote(input) {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) return null;

  // scp-like: git@github.com:owner/repo.git
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(raw);
  if (scp && !raw.includes('://')) {
    return validateRepoRef(normalizeHost(scp[1]), scp[2], scp[3].replace(/\.git$/i, ''), raw, true);
  }

  // ssh://git@github.com/owner/repo.git or https://github.com/owner/repo.git
  const url = /^(?:ssh|git|https?):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(raw);
  if (url) {
    return validateRepoRef(normalizeHost(url[1]), url[2], url[3].replace(/\.git$/i, ''), raw, true);
  }

  return null;
}

function validateRepoRef(host, owner, name, source, quiet = false) {
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name) || name === '.' || name === '..') {
    if (quiet) return null;
    throw new Error(`repo must look like "owner/name", got "${source}".`);
  }
  return { host, owner, name, full: `${owner}/${name}` };
}

/** True for a syntactically valid `owner/name`. */
export function isRepoFullName(value) {
  return typeof value === 'string' && FULL_PATTERN.test(value);
}

/** Build a normalized ref from parts. */
export function repoRef(owner, name, host = 'github.com') {
  return { host: normalizeHost(host), owner, name, full: `${owner}/${name}` };
}
