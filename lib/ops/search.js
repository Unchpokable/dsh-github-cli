/**
 * GitHub search over repositories, issues/PRs, code, and users.
 *
 * Search is read-only but has a smaller rate-limit bucket; keep result pages and
 * text bounded.
 */

import { defineOperation } from './registry.js';
import { GitHubError } from '../errors.js';

const KINDS = new Set(['repositories', 'issues', 'code', 'users']);
const ENDPOINT = {
  repositories: 'search/repositories',
  issues: 'search/issues',
  code: 'search/code',
  users: 'search/users',
};

function client(ctx) {
  if (!ctx.gh) throw new GitHubError('The GitHub REST client is not available.', { code: 'unsupported' });
  return ctx.gh;
}

function project(kind, item) {
  if (kind === 'repositories') {
    return { full_name: item.full_name, name: item.name, description: item.description ?? null, stars: item.stargazers_count ?? null, html_url: item.html_url };
  }
  if (kind === 'issues') {
    return { number: item.number, title: item.title, state: item.state, repo: item.repository_url?.split('/').slice(-2).join('/') ?? null, html_url: item.html_url };
  }
  if (kind === 'code') {
    return { path: item.path, repo: item.repository?.full_name ?? null, html_url: item.html_url };
  }
  return { login: item.login, html_url: item.html_url };
}

defineOperation({
  tool: 'github_search',
  action: 'search',
  risk: 'read',
  async validate(args) {
    if (!KINDS.has(String(args.kind ?? ''))) {
      throw new GitHubError(`kind must be one of ${[...KINDS].join(', ')}.`, { code: 'validation' });
    }
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      throw new GitHubError('query is required.', { code: 'validation' });
    }
  },
  async prepare(ctx, args) {
    const kind = String(args.kind);
    const query = String(args.query).trim();
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 30;
    return { kind, query, limit, args };
  },
  async apply(ctx, prepared) {
    const endpoint = `${ENDPOINT[prepared.kind]}?q=${encodeURIComponent(prepared.query)}&per_page=${prepared.limit}`;
    const data = await client(ctx).apiJson(ctx.config, endpoint, { signal: ctx.signal });
    const items = Array.isArray(data?.items) ? data.items.map((item) => project(prepared.kind, item)) : [];
    return {
      summary: `${data?.total_count ?? items.length} ${prepared.kind} result${items.length === 1 ? '' : 's'} for "${prepared.query}"`,
      data: {
        kind: 'search',
        search_kind: prepared.kind,
        items,
        total: Number.isFinite(data?.total_count) ? data.total_count : null,
        truncated: data?.incomplete_results === true || items.length === prepared.limit,
      },
    };
  },
});
