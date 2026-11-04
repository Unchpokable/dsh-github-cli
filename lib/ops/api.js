/**
 * Generic REST/GraphQL escape hatch for endpoints without a domain tool.
 *
 * It is read-only unless the plugin config allows writes and the caller passes
 * `allow_write: true`; DELETE is admin-risk and needs a matching confirm string.
 */

import { defineOperation } from './registry.js';
import { GitHubError } from '../errors.js';

function client(ctx) {
  if (!ctx.gh) throw new GitHubError('The GitHub transport is not available.', { code: 'unsupported' });
  return ctx.gh;
}

function normalizePath(input) {
  const path = String(input ?? '').trim();
  if (path.length === 0) throw new GitHubError('path is required.', { code: 'validation' });
  if (path.includes('://')) throw new GitHubError('path must be relative to the GitHub API, not a full URL.', { code: 'validation' });
  if (path.split('/').some((segment) => segment === '..')) {
    throw new GitHubError('path must not contain "..".', { code: 'validation' });
  }
  return path.replace(/^\/+/, '');
}

function selectValue(value, selector) {
  if (typeof selector !== 'string' || selector.trim().length === 0) return value;
  let current = value;
  for (const part of selector.split('.')) {
    if (current === null || current === undefined) return null;
    current = current[part];
  }
  return current;
}

defineOperation({
  tool: 'github_api',
  action: 'request',
  risk: 'read',
  async validate(args) {
    if (args.graphql === undefined) normalizePath(args.path);
    if (args.graphql !== undefined && typeof args.graphql !== 'string') {
      throw new GitHubError('graphql must be a query string.', { code: 'validation' });
    }
  },
  async prepare(ctx, args) {
    const graphql = typeof args.graphql === 'string' && args.graphql.trim().length > 0;
    const method = String(args.method ?? (graphql ? 'POST' : 'GET')).toUpperCase();
    const isWrite = !graphql && method !== 'GET' && method !== 'HEAD';
    const isMutation = graphql && /(^|\s)mutation(\s|\{|\()/i.test(args.graphql);
    const isDelete = method === 'DELETE';
    if (isWrite || isMutation) {
      if (ctx.config.allowGenericApi !== 'write') {
        throw new GitHubError('Generic API writes are disabled by allowGenericApi.', { code: 'policy' });
      }
      if (args.allow_write !== true) {
        throw new GitHubError('Pass allow_write: true to use a generic API write.', { code: 'validation' });
      }
    }
    let path = null;
    if (!graphql) {
      path = normalizePath(args.path);
      if (args.query && typeof args.query === 'object') {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(args.query)) {
          if (value !== undefined && value !== null) query.set(key, String(value));
        }
        if (query.size > 0) path = `${path}${path.includes('?') ? '&' : '?'}${query}`;
      }
    }
    return { graphql, method, path, isDelete, args };
  },
  async plan(ctx, prepared) {
    const risk = prepared.isDelete ? 'admin' : (prepared.graphql || prepared.method === 'GET' ? 'read' : 'write');
    return {
      summary: prepared.graphql ? 'GraphQL request' : `${prepared.method} ${prepared.path}`,
      effects: risk === 'read' ? [] : [`${prepared.method} request against the GitHub API`],
      risk,
      confirm: prepared.isDelete ? (prepared.path ?? 'graphql') : null,
    };
  },
  async apply(ctx, prepared) {
    let data;
    if (prepared.graphql) {
      data = await client(ctx).graphql(ctx.config, prepared.args.graphql, prepared.args.variables ?? {}, { signal: ctx.signal });
    } else {
      const response = await client(ctx).apiRequest(ctx.config, prepared.path, {
        method: prepared.method,
        ...(prepared.args.body === undefined ? {} : { input: prepared.args.body }),
        ...(prepared.args.accept ? { accept: prepared.args.accept } : {}),
        signal: ctx.signal,
      });
      const text = response.body.trim();
      data = text.length === 0 ? null : JSON.parse(text);
    }
    const selected = selectValue(data, prepared.args.select);
    return {
      summary: `${prepared.graphql ? 'GraphQL' : `${prepared.method} ${prepared.path}`} succeeded`,
      data: { kind: 'api', response: selected },
    };
  },
});
