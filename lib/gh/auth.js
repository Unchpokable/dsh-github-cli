/**
 * Authentication and host discovery through `gh auth status`.
 *
 * The plugin never reads the token itself. It only asks gh which hosts are
 * signed in, under which accounts, and with which scopes, then uses the same gh
 * login for every request.
 */

import { run } from './exec.js';
import { resolveGh } from './exec.js';
import { apiJson } from './rest.js';

const SOURCE_LABELS = {
  PATH: 'found on PATH',
  'ghPath config': 'configured ghPath',
  'standard install location': 'standard install location (not on PATH)',
};

/** Render a discovery source for humans. */
export function sourceLabel(source) {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * Parse `gh auth status` into host records.
 *
 * Supports both the newer "Logged in to <host> account <login>" wording and
 * the older "Logged in to <host> as <login>" form.
 *
 * @param {string} detail - combined stdout and stderr.
 * @returns {{host: string, account: string, active: boolean, scopes: string[]}[]}
 */
export function parseAuthStatus(detail) {
  const lines = String(detail ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const hosts = [];
  let current = null;

  const flush = () => {
    if (current !== null && current.account.length > 0) hosts.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const hostHeader = /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d+)?)\s*$/.exec(line);
    if (hostHeader) {
      flush();
      current = { host: hostHeader[1].toLowerCase(), account: '', active: false, scopes: [] };
      continue;
    }
    if (current === null) continue;

    const login = /Logged in to (\S+)\s+(?:account|as)\s+(\S+)/i.exec(line);
    if (login) {
      current.host = login[1].toLowerCase();
      current.account = login[2].replace(/[),]$/, '');
      continue;
    }
    if (/Active account:\s*true/i.test(line)) current.active = true;
    const scopes = /Token scopes:\s*(.+)/i.exec(line);
    if (scopes) {
      current.scopes = scopes[1]
        .split(',')
        .map((scope) => scope.trim().replace(/^'|'$/g, '').replace(/^"|"$/g, ''))
        .filter((scope) => scope.length > 0 && scope.toLowerCase() !== 'none');
    }
  }
  flush();

  // A single-host output may omit the host header; recover the host from the
  // "Logged in to" line when the header was absent.
  if (hosts.length === 0) {
    const login = /Logged in to (\S+)\s+(?:account|as)\s+(\S+)/i.exec(String(detail));
    if (login) {
      hosts.push({
        host: login[1].toLowerCase(),
        account: login[2].replace(/[),]$/, ''),
        active: true,
        scopes: [],
      });
    }
  }

  return hosts;
}

/**
 * Read the current authentication and quota state.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} model-facing status value.
 */
export async function readAuthStatus(config, signal) {
  const executable = await resolveGh(config);
  const auth = await run(executable.path, ['auth', 'status'], { timeoutMs: config.timeoutMs, signal });
  const detail = `${auth.stdout}\n${auth.stderr}`.trim();
  const hosts = parseAuthStatus(detail);
  const primary = hosts.find((entry) => entry.active) ?? hosts[0] ?? null;

  let rateLimit = null;
  if (primary !== null) {
    try {
      const limits = await apiJson(config, 'rate_limit', { signal });
      const core = limits?.resources?.core;
      if (core) {
        rateLimit = {
          limit: Number.isFinite(core.limit) ? core.limit : null,
          used: Number.isFinite(core.used) ? core.used : null,
          remaining: Number.isFinite(core.remaining) ? core.remaining : null,
          reset_at: Number.isFinite(core.reset) ? new Date(core.reset * 1000).toISOString() : null,
        };
      }
    } catch {
      rateLimit = null;
    }
  }

  return {
    found: true,
    path: executable.path,
    version: executable.version,
    source: executable.source,
    authenticated: primary !== null,
    host: primary?.host ?? null,
    account: primary?.account ?? null,
    scopes: primary?.scopes ?? [],
    hosts,
    rate_limit: rateLimit,
    detail: primary === null ? detail.slice(0, 2000) : null,
  };
}

/**
 * Render an auth status value. The first lines match the original tool output;
 * multi-host and capability details are appended only when present.
 *
 * @param {object} value - auth status.
 * @returns {string}
 */
export function renderAuthStatus(value) {
  const lines = [
    `GitHub CLI ${value.version} at ${value.path} (${sourceLabel(value.source)})`,
  ];
  if (value.authenticated) {
    lines.push(`authenticated: yes — ${value.host}/${value.account}`);
    if (value.scopes.length > 0) lines.push(`token scopes: ${value.scopes.join(', ')}`);
    if (value.rate_limit) {
      const rate = value.rate_limit;
      const reset = rate.reset_at ? ` · resets ${rate.reset_at}` : '';
      lines.push(`core API: ${rate.remaining ?? '?'}/${rate.limit ?? '?'} remaining${reset}`);
    }
    if (Array.isArray(value.hosts) && value.hosts.length > 1) {
      lines.push('hosts:');
      for (const host of value.hosts) {
        const marker = host.host === value.host ? '*' : ' ';
        lines.push(` ${marker} ${host.host}/${host.account}${host.scopes.length > 0 ? ` (${host.scopes.join(', ')})` : ''}`);
      }
    }
  } else {
    lines.push('authenticated: no');
    lines.push('Run `gh auth login`, or set GH_TOKEN for an account that can read the repositories you need.');
    if (value.detail) lines.push('', value.detail);
  }
  return lines.join('\n');
}
