/**
 * Issue management: list, view, create, update, comments, labels, assignees,
 * milestones, lock/unlock, and transfer.
 */

import { defineOperation } from './registry.js';
import { GitHubError } from '../errors.js';

function client(ctx) {
  if (!ctx.gh) throw new GitHubError('The GitHub REST client is not available.', { code: 'unsupported' });
  return ctx.gh;
}

function repoPath(ref, suffix = '') {
  return `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}${suffix}`;
}

function parseIssue(input) {
  const text = String(input ?? '').trim();
  const url = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i.exec(text);
  if (url) return { number: Number(url[4]), repo: `${url[2]}/${url[3]}`, host: url[1] };
  if (/^\d+$/.test(text) && Number(text) > 0) return { number: Number(text) };
  throw new GitHubError(`issue must be an issue number or URL, got "${text}".`, { code: 'validation' });
}

function issueTarget(ctx, args) {
  const parsed = parseIssue(args.issue ?? args.number);
  const ref = ctx.session.resolveRepo(args.repo, { fromPull: parsed.repo, cwd: ctx.session.cwd });
  return { ref, number: parsed.number };
}

function projectIssue(issue) {
  return {
    number: issue.number ?? null,
    title: issue.title ?? '',
    state: String(issue.state ?? 'unknown').toUpperCase(),
    state_reason: issue.state_reason ?? null,
    author: issue.user?.login ?? null,
    labels: Array.isArray(issue.labels) ? issue.labels.map((label) => (typeof label === 'string' ? label : label.name)).filter(Boolean) : [],
    assignees: Array.isArray(issue.assignees) ? issue.assignees.map((user) => user.login) : [],
    milestone: issue.milestone?.number ?? null,
    comments: issue.comments ?? 0,
    locked: issue.locked === true,
    html_url: issue.html_url ?? null,
    pull_request: issue.pull_request !== undefined,
    updated_at: issue.updated_at ?? null,
  };
}

defineOperation({
  tool: 'github_issue',
  action: 'list',
  risk: 'read',
  async prepare(ctx, args) {
    const ref = ctx.session.resolveRepo(args.repo, { cwd: ctx.session.cwd });
    return { ref, args };
  },
  async apply(ctx, prepared) {
    const { ref, args } = prepared;
    const query = new URLSearchParams();
    query.set('state', String(args.state ?? 'open'));
    if (args.labels) query.set('labels', Array.isArray(args.labels) ? args.labels.join(',') : String(args.labels));
    if (args.assignee) query.set('assignee', String(args.assignee));
    if (args.creator) query.set('creator', String(args.creator));
    if (args.milestone) query.set('milestone', String(args.milestone));
    if (args.since) query.set('since', String(args.since));
    const listed = await client(ctx).apiList(ctx.config, `${repoPath(ref, '/issues')}?${query}`, { signal: ctx.signal });
    const items = listed.items
      .filter((issue) => args.include_pulls === true || issue.pull_request === undefined)
      .map(projectIssue);
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 100;
    const visible = items.slice(0, limit);
    return {
      repo: ref.full,
      summary: `${visible.length} issue${visible.length === 1 ? '' : 's'} in ${ref.full}`,
      data: { kind: 'issue-list', items: visible, total: listed.complete ? items.length : null, truncated: !listed.complete || items.length > visible.length },
    };
  },
});

defineOperation({
  tool: 'github_issue',
  action: 'view',
  risk: 'read',
  async prepare(ctx, args) {
    const target = issueTarget(ctx, args);
    return { ...target, args };
  },
  async apply(ctx, prepared) {
    const issue = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/issues/${prepared.number}`), { signal: ctx.signal });
    return {
      repo: prepared.ref.full,
      summary: `${prepared.ref.full}#${prepared.number} — ${issue?.title ?? ''}`,
      url: issue?.html_url ?? null,
      data: { kind: 'issue', issue: projectIssue(issue), body: issue?.body ?? null },
    };
  },
});

defineOperation({
  tool: 'github_issue',
  action: 'create',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = ctx.session.resolveRepo(args.repo, { cwd: ctx.session.cwd });
    const title = String(args.title ?? '').trim();
    if (title.length === 0) throw new GitHubError('title is required.', { code: 'validation' });
    return { ref, args };
  },
  async apply(ctx, prepared) {
    const { ref, args } = prepared;
    const input = { title: String(args.title).trim() };
    if (typeof args.body === 'string' && args.body.trim().length > 0) input.body = args.body;
    if (Array.isArray(args.labels) && args.labels.length > 0) input.labels = args.labels.map(String);
    if (Array.isArray(args.assignees) && args.assignees.length > 0) input.assignees = args.assignees.map(String);
    if (Number.isInteger(args.milestone)) input.milestone = args.milestone;
    const issue = await client(ctx).apiJson(ctx.config, repoPath(ref, '/issues'), {
      method: 'POST',
      input,
      signal: ctx.signal,
    });
    return {
      repo: ref.full,
      summary: `Opened ${ref.full}#${issue?.number ?? '?'} — ${issue?.title ?? input.title}`,
      url: issue?.html_url ?? null,
      data: { kind: 'issue', issue: projectIssue(issue) },
    };
  },
});

defineOperation({
  tool: 'github_issue',
  action: 'update',
  risk: 'write',
  async prepare(ctx, args) {
    const target = issueTarget(ctx, args);
    return { ...target, args };
  },
  async apply(ctx, prepared) {
    const input = {};
    for (const field of ['title', 'body', 'state_reason', 'milestone', 'type']) {
      if (prepared.args[field] !== undefined) input[field] = prepared.args[field];
    }
    if (Array.isArray(prepared.args.labels)) input.labels = prepared.args.labels.map(String);
    if (Array.isArray(prepared.args.assignees)) input.assignees = prepared.args.assignees.map(String);
    if (Object.keys(input).length === 0) throw new GitHubError('Nothing to update.', { code: 'validation' });
    const issue = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/issues/${prepared.number}`), {
      method: 'PATCH',
      input,
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Updated ${prepared.ref.full}#${prepared.number}`,
      url: issue?.html_url ?? null,
      data: { kind: 'issue', issue: projectIssue(issue) },
    };
  },
});

for (const [action, state, verb] of [['close', 'closed', 'Closed'], ['reopen', 'open', 'Reopened']]) {
  defineOperation({
    tool: 'github_issue',
    action,
    risk: 'write',
    async prepare(ctx, args) {
      return { ...issueTarget(ctx, args), args };
    },
    async apply(ctx, prepared) {
      const input = { state };
      if (action === 'close' && prepared.args.state_reason) input.state_reason = prepared.args.state_reason;
      const issue = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/issues/${prepared.number}`), {
        method: 'PATCH',
        input,
        signal: ctx.signal,
      });
      return {
        repo: prepared.ref.full,
        summary: `${verb} ${prepared.ref.full}#${prepared.number}`,
        url: issue?.html_url ?? null,
        data: { kind: 'issue', issue: projectIssue(issue) },
      };
    },
  });
}

defineOperation({
  tool: 'github_issue',
  action: 'comment',
  risk: 'write',
  async prepare(ctx, args) {
    const target = issueTarget(ctx, args);
    const body = typeof args.body === 'string' ? args.body : '';
    if (body.trim().length === 0) throw new GitHubError('body is required.', { code: 'validation' });
    return { ...target, body, args };
  },
  async apply(ctx, prepared) {
    const comment = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/issues/${prepared.number}/comments`), {
      method: 'POST',
      input: { body: prepared.body },
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Commented on ${prepared.ref.full}#${prepared.number}`,
      url: comment?.html_url ?? null,
      data: { kind: 'issue-comment', id: comment?.id ?? null },
    };
  },
});

defineOperation({
  tool: 'github_issue',
  action: 'label',
  risk: 'write',
  async prepare(ctx, args) {
    const target = issueTarget(ctx, args);
    const add = Array.isArray(args.add) ? args.add.map(String) : [];
    const remove = Array.isArray(args.remove) ? args.remove.map(String) : [];
    const set = Array.isArray(args.set) ? args.set.map(String) : null;
    if (add.length === 0 && remove.length === 0 && set === null) {
      throw new GitHubError('label needs add, remove, or set.', { code: 'validation' });
    }
    return { ...target, add, remove, set, args };
  },
  async apply(ctx, prepared) {
    const endpoint = repoPath(prepared.ref, `/issues/${prepared.number}/labels`);
    if (prepared.set !== null) {
      await client(ctx).apiJson(ctx.config, endpoint, { method: 'PUT', input: { labels: prepared.set }, signal: ctx.signal });
    } else if (prepared.add.length > 0) {
      await client(ctx).apiJson(ctx.config, endpoint, { method: 'POST', input: { labels: prepared.add }, signal: ctx.signal });
    }
    for (const label of prepared.remove) {
      await client(ctx).apiJson(ctx.config, `${endpoint}/${encodeURIComponent(label)}`, { method: 'DELETE', signal: ctx.signal });
    }
    return {
      repo: prepared.ref.full,
      summary: `Updated labels on ${prepared.ref.full}#${prepared.number}`,
      data: { kind: 'issue-labels', set: prepared.set, added: prepared.add, removed: prepared.remove },
    };
  },
});

defineOperation({
  tool: 'github_issue',
  action: 'assign',
  risk: 'write',
  async prepare(ctx, args) {
    const target = issueTarget(ctx, args);
    const add = Array.isArray(args.add) ? args.add.map(String) : [];
    const remove = Array.isArray(args.remove) ? args.remove.map(String) : [];
    if (add.length === 0 && remove.length === 0) throw new GitHubError('assign needs add or remove.', { code: 'validation' });
    return { ...target, add, remove, args };
  },
  async apply(ctx, prepared) {
    const endpoint = repoPath(prepared.ref, `/issues/${prepared.number}/assignees`);
    if (prepared.add.length > 0) {
      await client(ctx).apiJson(ctx.config, endpoint, { method: 'POST', input: { assignees: prepared.add }, signal: ctx.signal });
    }
    if (prepared.remove.length > 0) {
      await client(ctx).apiJson(ctx.config, endpoint, { method: 'DELETE', input: { assignees: prepared.remove }, signal: ctx.signal });
    }
    return {
      repo: prepared.ref.full,
      summary: `Updated assignees on ${prepared.ref.full}#${prepared.number}`,
      data: { kind: 'issue-assignees', added: prepared.add, removed: prepared.remove },
    };
  },
});

defineOperation({
  tool: 'github_issue',
  action: 'milestone',
  risk: 'write',
  async prepare(ctx, args) {
    const target = issueTarget(ctx, args);
    return { ...target, args };
  },
  async apply(ctx, prepared) {
    const milestone = Number.isInteger(prepared.args.milestone) ? prepared.args.milestone : null;
    const issue = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/issues/${prepared.number}`), {
      method: 'PATCH',
      input: { milestone },
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: milestone === null ? `Cleared milestone on ${prepared.ref.full}#${prepared.number}` : `Set milestone ${milestone} on ${prepared.ref.full}#${prepared.number}`,
      data: { kind: 'issue', issue: projectIssue(issue) },
    };
  },
});

defineOperation({
  tool: 'github_issue',
  action: 'lock',
  risk: 'write',
  async prepare(ctx, args) {
    return { ...issueTarget(ctx, args), args };
  },
  async apply(ctx, prepared) {
    await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/issues/${prepared.number}/lock`), {
      method: 'PUT',
      input: { lock_reason: prepared.args.reason ?? 'resolved' },
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Locked ${prepared.ref.full}#${prepared.number}`,
      data: { kind: 'issue-lock', locked: true },
    };
  },
});

defineOperation({
  tool: 'github_issue',
  action: 'unlock',
  risk: 'write',
  async prepare(ctx, args) {
    return { ...issueTarget(ctx, args), args };
  },
  async apply(ctx, prepared) {
    await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/issues/${prepared.number}/lock`), {
      method: 'DELETE',
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Unlocked ${prepared.ref.full}#${prepared.number}`,
      data: { kind: 'issue-lock', locked: false },
    };
  },
});

defineOperation({
  tool: 'github_issue',
  action: 'transfer',
  risk: 'write',
  async prepare(ctx, args) {
    const target = issueTarget(ctx, args);
    const newRepo = String(args.new_repo ?? '').trim();
    if (newRepo.length === 0) throw new GitHubError('new_repo is required.', { code: 'validation' });
    return { ...target, newRepo, args };
  },
  async apply(ctx, prepared) {
    const issue = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/issues/${prepared.number}/transfer`), {
      method: 'POST',
      input: { new_repo: prepared.newRepo },
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Transferred ${prepared.ref.full}#${prepared.number} to ${prepared.newRepo}`,
      url: issue?.html_url ?? null,
      data: { kind: 'issue', issue: projectIssue(issue) },
    };
  },
});
