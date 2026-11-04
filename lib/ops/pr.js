/**
 * Pull request management: list, edit, close/reopen, comment, label, reviewers,
 * merge, and branch updates.
 *
 * Reading a PR stays in the original `github_pr` path; these operations are the
 * mutations that were missing from the first version.
 */

import { defineOperation } from './registry.js';
import { GitHubError } from '../errors.js';
import { parsePull } from '../repo.js';
import { nextStep } from '../result.js';

function client(ctx) {
  if (!ctx.gh) throw new GitHubError('The GitHub REST client is not available.', { code: 'unsupported' });
  return ctx.gh;
}

function repoFor(ctx, args) {
  return ctx.session.resolveRepo(args.repo, {
    fromPull: parsePull(args.pr).repo,
    cwd: ctx.session.cwd,
  });
}

function pullNumber(args) {
  return parsePull(args.pr).number;
}

function pullPath(ref, number, suffix = '') {
  return `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/pulls/${number}${suffix}`;
}

function repoPath(ref, suffix = '') {
  return `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}${suffix}`;
}

function projectPull(pull) {
  return {
    number: pull.number ?? null,
    title: pull.title ?? '',
    state: String(pull.state ?? 'unknown').toUpperCase(),
    draft: pull.draft === true,
    merged: pull.merged === true,
    author: pull.user?.login ?? null,
    base: pull.base?.ref ?? null,
    head: pull.head?.ref ?? null,
    head_sha: pull.head?.sha ?? null,
    html_url: pull.html_url ?? null,
    mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null,
    mergeable_state: pull.mergeable_state ?? null,
    labels: Array.isArray(pull.labels) ? pull.labels.map((label) => label.name).filter(Boolean) : [],
    requested_reviewers: Array.isArray(pull.requested_reviewers) ? pull.requested_reviewers.map((user) => user.login) : [],
    updated_at: pull.updated_at ?? null,
  };
}

async function loadPull(ctx, ref, number) {
  const pull = await client(ctx).apiJson(ctx.config, pullPath(ref, number), { signal: ctx.signal });
  if (!pull || typeof pull !== 'object') {
    throw new GitHubError(`Pull request ${ref.full}#${number} was not found.`, { code: 'not_found' });
  }
  return pull;
}

async function patchPull(ctx, ref, number, input, summary) {
  const pull = await client(ctx).apiJson(ctx.config, pullPath(ref, number), {
    method: 'PATCH',
    input,
    signal: ctx.signal,
  });
  return {
    repo: ref.full,
    summary,
    url: pull?.html_url ?? null,
    data: { kind: 'pull', pull: projectPull(pull) },
  };
}

defineOperation({
  tool: 'github_pr',
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
    if (args.sort) query.set('sort', String(args.sort));
    if (args.direction) query.set('direction', String(args.direction));
    if (args.base) query.set('base', String(args.base));
    if (args.head) query.set('head', String(args.head));
    const listed = await client(ctx).apiList(ctx.config, `${repoPath(ref, '/pulls')}?${query}`, {
      signal: ctx.signal,
    });
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 100;
    const items = listed.items.slice(0, limit).map(projectPull);
    return {
      repo: ref.full,
      summary: `${items.length} pull request${items.length === 1 ? '' : 's'} in ${ref.full}`,
      data: { kind: 'pull-list', items, total: listed.complete ? listed.items.length : null, truncated: !listed.complete || listed.items.length > items.length },
    };
  },
});

defineOperation({
  tool: 'github_pr',
  action: 'update',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const number = pullNumber(args);
    if (args.title === undefined && args.body === undefined && args.base === undefined) {
      throw new GitHubError('Nothing to update: pass title, body, or base.', { code: 'validation' });
    }
    return { ref, number, args };
  },
  async apply(ctx, prepared) {
    const input = {};
    for (const field of ['title', 'body', 'base']) {
      if (prepared.args[field] !== undefined) input[field] = prepared.args[field];
    }
    return patchPull(ctx, prepared.ref, prepared.number, input, `Updated ${prepared.ref.full}#${prepared.number}`);
  },
});

for (const [action, state, verb] of [['close', 'closed', 'Closed'], ['reopen', 'open', 'Reopened']]) {
  defineOperation({
    tool: 'github_pr',
    action,
    risk: 'write',
    async prepare(ctx, args) {
      return { ref: repoFor(ctx, args), number: pullNumber(args), args };
    },
    async apply(ctx, prepared) {
      return patchPull(ctx, prepared.ref, prepared.number, { state }, `${verb} ${prepared.ref.full}#${prepared.number}`);
    },
  });
}

defineOperation({
  tool: 'github_pr',
  action: 'comment',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const number = pullNumber(args);
    const body = typeof args.body === 'string' ? args.body : '';
    if (body.trim().length === 0) throw new GitHubError('body is required for a comment.', { code: 'validation' });
    return { ref, number, body, args };
  },
  async apply(ctx, prepared) {
    const comment = await client(ctx).apiJson(ctx.config, `repos/${encodeURIComponent(prepared.ref.owner)}/${encodeURIComponent(prepared.ref.name)}/issues/${prepared.number}/comments`, {
      method: 'POST',
      input: { body: prepared.body },
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Commented on ${prepared.ref.full}#${prepared.number}`,
      url: comment?.html_url ?? null,
      data: { kind: 'pull-comment', id: comment?.id ?? null, url: comment?.html_url ?? null },
    };
  },
});

defineOperation({
  tool: 'github_pr',
  action: 'label',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const number = pullNumber(args);
    const add = Array.isArray(args.add) ? args.add.map(String) : [];
    const remove = Array.isArray(args.remove) ? args.remove.map(String) : [];
    const set = Array.isArray(args.set) ? args.set.map(String) : null;
    if (add.length === 0 && remove.length === 0 && set === null) {
      throw new GitHubError('label needs add, remove, or set.', { code: 'validation' });
    }
    return { ref, number, add, remove, set, args };
  },
  async apply(ctx, prepared) {
    const endpoint = `repos/${encodeURIComponent(prepared.ref.owner)}/${encodeURIComponent(prepared.ref.name)}/issues/${prepared.number}/labels`;
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
      data: { kind: 'pull-labels', set: prepared.set, added: prepared.add, removed: prepared.remove },
    };
  },
});

defineOperation({
  tool: 'github_pr',
  action: 'reviewers',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const number = pullNumber(args);
    const addUsers = Array.isArray(args.add_users) ? args.add_users.map(String) : [];
    const addTeams = Array.isArray(args.add_teams) ? args.add_teams.map(String) : [];
    const removeUsers = Array.isArray(args.remove_users) ? args.remove_users.map(String) : [];
    const removeTeams = Array.isArray(args.remove_teams) ? args.remove_teams.map(String) : [];
    if ([addUsers, addTeams, removeUsers, removeTeams].every((list) => list.length === 0)) {
      throw new GitHubError('reviewers needs at least one add/remove list.', { code: 'validation' });
    }
    return { ref, number, addUsers, addTeams, removeUsers, removeTeams, args };
  },
  async apply(ctx, prepared) {
    const endpoint = pullPath(prepared.ref, prepared.number, '/requested_reviewers');
    if (prepared.addUsers.length > 0 || prepared.addTeams.length > 0) {
      await client(ctx).apiJson(ctx.config, endpoint, {
        method: 'POST',
        input: { reviewers: prepared.addUsers, team_reviewers: prepared.addTeams },
        signal: ctx.signal,
      });
    }
    if (prepared.removeUsers.length > 0 || prepared.removeTeams.length > 0) {
      await client(ctx).apiJson(ctx.config, endpoint, {
        method: 'DELETE',
        input: { reviewers: prepared.removeUsers, team_reviewers: prepared.removeTeams },
        signal: ctx.signal,
      });
    }
    return {
      repo: prepared.ref.full,
      summary: `Updated reviewers on ${prepared.ref.full}#${prepared.number}`,
      data: { kind: 'pull-reviewers', added: prepared.addUsers, removed: prepared.removeUsers },
    };
  },
});

defineOperation({
  tool: 'github_pr',
  action: 'update_branch',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const number = pullNumber(args);
    const pull = await loadPull(ctx, ref, number);
    return { ref, number, headSha: pull.head?.sha ?? null, args };
  },
  async apply(ctx, prepared) {
    const pull = await client(ctx).apiJson(ctx.config, pullPath(prepared.ref, prepared.number, '/update-branch'), {
      method: 'PUT',
      input: prepared.headSha ? { expected_head_sha: prepared.headSha } : {},
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Updated branch for ${prepared.ref.full}#${prepared.number}`,
      url: pull?.html_url ?? null,
      data: { kind: 'pull-update-branch', message: pull?.message ?? null },
    };
  },
});

for (const [action, mutation, verb] of [
  ['ready', 'markPullRequestReadyForReview', 'Marked ready'],
  ['draft', 'convertPullRequestToDraft', 'Converted to draft'],
]) {
  defineOperation({
    tool: 'github_pr',
    action,
    risk: 'write',
    async prepare(ctx, args) {
      const ref = repoFor(ctx, args);
      const number = pullNumber(args);
      const pull = await loadPull(ctx, ref, number);
      if (!pull.node_id) throw new GitHubError('GitHub did not return a node id for this pull request.', { code: 'unknown' });
      return { ref, number, nodeId: pull.node_id, args };
    },
    async apply(ctx, prepared) {
      if (typeof client(ctx).graphql !== 'function') {
        throw new GitHubError('This operation needs the GraphQL client.', { code: 'unsupported' });
      }
      const query = `mutation($id: ID!) { ${mutation}(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`;
      await client(ctx).graphql(ctx.config, query, { id: prepared.nodeId }, { signal: ctx.signal });
      return {
        repo: prepared.ref.full,
        summary: `${verb} ${prepared.ref.full}#${prepared.number}`,
        data: { kind: 'pull-draft-state', draft: action === 'draft' },
      };
    },
  });
}

defineOperation({
  tool: 'github_pr',
  action: 'merge',
  risk: 'destructive',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const number = pullNumber(args);
    const pull = await loadPull(ctx, ref, number);
    if (String(pull.state).toLowerCase() !== 'open') {
      throw new GitHubError(`Pull request ${ref.full}#${number} is not open.`, { code: 'conflict' });
    }
    if (pull.mergeable === false) {
      throw new GitHubError(`Pull request ${ref.full}#${number} is not mergeable: ${pull.mergeable_state ?? 'unknown'}.`, {
        code: 'conflict',
      });
    }
    const repo = await client(ctx).apiJson(ctx.config, repoPath(ref), { signal: ctx.signal });
    return { ref, number, headSha: pull.head?.sha ?? null, head: pull.head?.ref ?? null, base: pull.base?.ref ?? null, defaultBranch: repo?.default_branch ?? null, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Merge ${prepared.ref.full}#${prepared.number} (${prepared.args.method ?? 'merge'})`,
      effects: [
        `Merge head ${prepared.headSha?.slice(0, 7) ?? '?'} into ${prepared.base ?? 'the base branch'}`,
        prepared.args.delete_branch === true ? 'Delete the head branch after merge' : 'Keep the head branch',
      ],
      confirm: `${prepared.ref.full}#${prepared.number}`,
    };
  },
  async apply(ctx, prepared) {
    const method = prepared.args.method ?? 'merge';
    if (!['merge', 'squash', 'rebase'].includes(method)) {
      throw new GitHubError('method must be merge, squash, or rebase.', { code: 'validation' });
    }
    const result = await client(ctx).apiJson(ctx.config, pullPath(prepared.ref, prepared.number, '/merge'), {
      method: 'PUT',
      input: {
        merge_method: method,
        ...(prepared.args.commit_title ? { commit_title: prepared.args.commit_title } : {}),
        ...(prepared.args.commit_message ? { commit_message: prepared.args.commit_message } : {}),
        ...(prepared.headSha ? { sha: prepared.headSha } : {}),
      },
      signal: ctx.signal,
    });
    let deleted = false;
    if (prepared.args.delete_branch === true && prepared.headSha) {
      const head = String(prepared.head ?? prepared.args.head ?? '').trim();
      if (head.length > 0 && head !== prepared.defaultBranch) {
        try {
          await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/git/refs/heads/${encodeURIComponent(head)}`), {
            method: 'DELETE',
            signal: ctx.signal,
          });
          deleted = true;
        } catch {
          deleted = false;
        }
      }
    }
    return {
      repo: prepared.ref.full,
      summary: `Merged ${prepared.ref.full}#${prepared.number} (${method})`,
      data: { kind: 'pull-merge', merged: result?.merged === true, message: result?.message ?? null, branch_deleted: deleted },
      next: [nextStep('github_pr', { action: 'view', repo: prepared.ref.full, pr: String(prepared.number) }, 'inspect the merged pull request')],
    };
  },
});
