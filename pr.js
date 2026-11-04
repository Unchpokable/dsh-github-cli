/**
 * Pull request reads and writes: PR overview, unified diffs, and creating a PR
 * from a branch that already exists on the remote.
 */

import { apiJson, apiList, apiText, ghCommand, parsePull, resolveRepo, shortSha } from './gh.js';

const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_COMMENT_CHARS = 3_000;
const MAX_COMMENTS_CHARS = 40_000;
const MAX_FILES = 300;
const MAX_COMMITS = 50;
const MAX_CHECKS = 50;
const INCLUDES = new Set(['description', 'files', 'comments', 'commits', 'checks']);

/** Clip text to a character bound without breaking surrogate pairs. */
function clip(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n\n[...]`, truncated: true };
}

function firstLine(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? '';
}

function parseInclude(input) {
  if (!Array.isArray(input) || input.length === 0) return new Set(['description', 'files']);
  const include = new Set();
  for (const raw of input) {
    const value = String(raw).trim().toLowerCase();
    if (!INCLUDES.has(value)) {
      throw new Error(`include accepts ${[...INCLUDES].join(', ')}; got "${raw}".`);
    }
    include.add(value);
  }
  return include;
}

function statusLetter(status) {
  switch (status) {
    case 'added': return 'A';
    case 'modified': return 'M';
    case 'removed': return 'D';
    case 'renamed': return 'R';
    case 'copied': return 'C';
    case 'changed': return 'M';
    default: return '?';
  }
}

function checkBucket(run) {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success': return 'passed';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
      return 'failed';
    case 'neutral':
    case 'skipped':
      return 'skipped';
    default:
      return 'pending';
  }
}

async function listFiles(config, repo, number, signal) {
  const { items, complete } = await apiList(config, `repos/${repo}/pulls/${number}/files`, { maxPages: 3, signal });
  const projected = items.slice(0, MAX_FILES).map((file) => ({
    path: file.filename ?? '',
    status: file.status ?? 'modified',
    additions: Number.isFinite(file.additions) ? file.additions : 0,
    deletions: Number.isFinite(file.deletions) ? file.deletions : 0,
    previous_path: typeof file.previous_filename === 'string' ? file.previous_filename : null,
  }));
  return {
    items: projected,
    total: complete ? items.length : null,
    truncated: !complete || items.length > MAX_FILES,
  };
}

async function listComments(config, repo, number, maxComments, signal) {
  const [conversation, inline, reviews] = await Promise.all([
    apiList(config, `repos/${repo}/issues/${number}/comments`, { maxPages: 2, signal }),
    apiList(config, `repos/${repo}/pulls/${number}/comments`, { maxPages: 2, signal }),
    apiList(config, `repos/${repo}/pulls/${number}/reviews`, { maxPages: 2, signal }),
  ]);

  const items = [];
  for (const comment of conversation.items) {
    items.push({
      kind: 'comment',
      author: comment.user?.login ?? null,
      created_at: comment.created_at ?? null,
      body: comment.body ?? '',
      path: null,
      line: null,
      state: null,
    });
  }
  for (const comment of inline.items) {
    items.push({
      kind: 'inline',
      author: comment.user?.login ?? null,
      created_at: comment.created_at ?? null,
      body: comment.body ?? '',
      path: comment.path ?? null,
      line: Number.isFinite(comment.line) ? comment.line : (Number.isFinite(comment.original_line) ? comment.original_line : null),
      start_line: Number.isFinite(comment.start_line) ? comment.start_line : null,
      state: null,
    });
  }
  for (const review of reviews.items) {
    items.push({
      kind: 'review',
      author: review.user?.login ?? null,
      created_at: review.submitted_at ?? review.created_at ?? null,
      body: review.body ?? '',
      path: null,
      line: null,
      state: typeof review.state === 'string' ? review.state.toUpperCase() : null,
    });
  }

  items.sort((left, right) => String(left.created_at ?? '').localeCompare(String(right.created_at ?? '')));

  const limit = Number.isInteger(maxComments) && maxComments > 0 ? maxComments : 40;
  const kept = items.length > limit ? items.slice(-limit) : items;

  const output = [];
  let budget = MAX_COMMENTS_CHARS;
  for (const item of kept) {
    const body = clip(item.body, MAX_COMMENT_CHARS);
    const cost = body.text.length + 120;
    if (cost > budget) continue;
    budget -= cost;
    output.push({ ...item, body: body.text, body_truncated: body.truncated });
  }

  return {
    items: output,
    total: items.length,
    truncated: output.length < items.length,
  };
}

async function listCommits(config, repo, number, signal) {
  const { items } = await apiList(config, `repos/${repo}/pulls/${number}/commits`, { maxPages: 1, signal });
  const projected = items.slice(0, MAX_COMMITS).map((entry) => ({
    sha: shortSha(entry.sha),
    message: firstLine(entry.commit?.message ?? ''),
    author: entry.author?.login ?? entry.commit?.author?.name ?? null,
    date: entry.commit?.author?.date ?? null,
  }));
  return {
    items: projected,
    total: items.length,
    truncated: items.length > MAX_COMMITS,
  };
}

async function listChecks(config, repo, sha, signal) {
  const data = await apiJson(config, `repos/${repo}/commits/${sha}/check-runs?per_page=100`, { signal });
  const runs = (data?.check_runs ?? []).map((run) => ({
    name: run.name ?? 'unnamed check',
    status: run.status ?? 'unknown',
    conclusion: run.conclusion ?? null,
  }));
  return {
    runs: runs.slice(0, MAX_CHECKS),
    total: Number.isFinite(data?.total_count) ? data.total_count : runs.length,
    truncated: runs.length > MAX_CHECKS,
  };
}

/**
 * Read one pull request.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} args - tool arguments.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} model-facing value.
 */
export async function readPull(config, args, signal) {
  const pullRef = parsePull(args.pr);
  const repo = resolveRepo(args.repo, config, pullRef.repo);
  const number = pullRef.number;
  const include = parseInclude(args.include);

  if (args.max_comments !== undefined && (!Number.isInteger(args.max_comments) || args.max_comments < 1)) {
    throw new Error('max_comments must be a positive integer.');
  }

  const pull = await apiJson(config, `repos/${repo}/pulls/${number}`, { signal });
  if (!pull || typeof pull !== 'object') {
    throw new Error(`Pull request ${repo}#${number} was not found.`);
  }

  const notes = [];
  const section = async (key, task) => {
    try {
      return await task();
    } catch (error) {
      notes.push(`${key}: ${error.message}`);
      return null;
    }
  };

  const [files, comments, commits, checks] = await Promise.all([
    include.has('files') ? section('files', () => listFiles(config, repo, number, signal)) : null,
    include.has('comments') ? section('comments', () => listComments(config, repo, number, args.max_comments, signal)) : null,
    include.has('commits') ? section('commits', () => listCommits(config, repo, number, signal)) : null,
    include.has('checks') ? section('checks', () => listChecks(config, repo, pull.head?.sha, signal)) : null,
  ]);

  const description = include.has('description')
    ? clip(pull.body ?? '', MAX_DESCRIPTION_CHARS)
    : { text: null, truncated: false };

  return {
    repo,
    number,
    title: pull.title ?? '',
    url: pull.html_url ?? '',
    state: String(pull.state ?? 'unknown').toUpperCase(),
    draft: Boolean(pull.draft),
    merged: Boolean(pull.merged),
    author: pull.user?.login ?? null,
    base: pull.base?.ref ?? null,
    head: pull.head?.ref ?? null,
    head_sha: pull.head?.sha ?? null,
    additions: Number.isFinite(pull.additions) ? pull.additions : 0,
    deletions: Number.isFinite(pull.deletions) ? pull.deletions : 0,
    changed_files: Number.isFinite(pull.changed_files) ? pull.changed_files : 0,
    commit_count: Number.isFinite(pull.commits) ? pull.commits : 0,
    comment_count: Number.isFinite(pull.comments) ? pull.comments : 0,
    review_comment_count: Number.isFinite(pull.review_comments) ? pull.review_comments : 0,
    created_at: pull.created_at ?? null,
    updated_at: pull.updated_at ?? null,
    body: description.text,
    body_truncated: description.truncated,
    files,
    comments,
    commits,
    checks,
    notes,
  };
}

/**
 * Render a `github_pr` value as model-facing text.
 *
 * @param {object} value - the tool output value.
 * @returns {string}
 */
export function renderPull(value) {
  const lines = [];
  lines.push(`# ${value.repo} #${value.number} — ${value.title}`);

  const flags = [`state ${String(value.state).toLowerCase()}`];
  if (value.draft) flags.push('draft');
  if (value.merged) flags.push('merged');
  lines.push(`${flags.join(' · ')} · @${value.author ?? 'unknown'} · ${value.base} ← ${value.head} (${shortSha(value.head_sha)})`);
  lines.push(`+${value.additions} -${value.deletions} · ${value.changed_files} files · ${value.commit_count} commits · ${value.comment_count} comments · ${value.review_comment_count} review comments`);
  if (value.url) lines.push(value.url);

  if (value.body !== null) {
    lines.push('', '## Description', value.body.trim() || '(no description)');
    if (value.body_truncated) lines.push('(description truncated)');
  }

  if (value.files !== null) {
    const suffix = value.files.truncated ? '+' : '';
    lines.push('', `## Files (${value.files.total ?? value.files.items.length}${suffix})`);
    if (value.files.items.length === 0) lines.push('(no changed files)');
    for (const file of value.files.items) {
      const rename = file.previous_path ? ` (was ${file.previous_path})` : '';
      lines.push(` ${statusLetter(file.status)} ${file.path}${rename} (+${file.additions} -${file.deletions})`);
    }
    if (value.files.truncated) lines.push('(file list truncated; use github_diff with paths to narrow it)');
  }

  if (value.comments !== null) {
    lines.push('', `## Comments (${value.comments.total})`);
    if (value.comments.items.length === 0 && value.comments.total === 0) {
      lines.push('(no conversation, review, or inline comments)');
    }
    for (const comment of value.comments.items) {
      const at = comment.created_at ? ` · ${comment.created_at}` : '';
      if (comment.kind === 'review') {
        lines.push(`### Review by @${comment.author ?? 'unknown'} · ${comment.state ?? 'COMMENTED'}${at}`);
      } else if (comment.kind === 'inline') {
        const range = comment.line === null
          ? ''
          : `${comment.start_line !== null && comment.start_line !== comment.line ? `${comment.start_line}-` : ''}${comment.line}`;
        const location = comment.path ? ` · ${comment.path}${range ? `:${range}` : ''}` : '';
        lines.push(`### Inline comment by @${comment.author ?? 'unknown'}${location}${at}`);
      } else {
        lines.push(`### Comment by @${comment.author ?? 'unknown'}${at}`);
      }
      lines.push(comment.body.trim() || '(no body)');
      if (comment.body_truncated) lines.push('(comment truncated)');
    }
    if (value.comments.truncated) {
      lines.push(`(showing ${value.comments.items.length} of ${value.comments.total} items; raise max_comments for more)`);
    }
  }

  if (value.commits !== null) {
    const suffix = value.commits.truncated ? '+' : '';
    lines.push('', `## Commits (${value.commits.total}${suffix})`);
    if (value.commits.items.length === 0) lines.push('(no commits)');
    for (const commit of value.commits.items) {
      lines.push(` ${commit.sha} ${commit.message}${commit.author ? ` (@${commit.author})` : ''}`);
    }
    if (value.commits.truncated) lines.push(`(showing the first ${value.commits.items.length} commits)`);
  }

  if (value.checks !== null) {
    const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
    for (const run of value.checks.runs) counts[checkBucket(run)] += 1;
    const summary = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([bucket, count]) => `${count} ${bucket}`)
      .join(', ');
    lines.push('', `## Checks (${value.checks.total})${summary ? `: ${summary}` : ''}`);
    if (value.checks.runs.length === 0) lines.push('(no check runs reported)');
    const visible = value.checks.runs.length <= 15
      ? value.checks.runs
      : value.checks.runs.filter((run) => checkBucket(run) !== 'passed');
    for (const run of visible) {
      const state = run.conclusion ? `${run.status}/${run.conclusion}` : run.status;
      lines.push(` ${checkBucket(run) === 'passed' ? 'ok  ' : checkBucket(run).padEnd(4)} ${run.name} — ${state}`);
    }
    if (visible.length < value.checks.runs.length) {
      lines.push(` (${value.checks.runs.length - visible.length} passing checks omitted)`);
    }
    if (value.checks.truncated) lines.push(`(showing the first ${value.checks.runs.length} checks)`);
  }

  if (value.notes.length > 0) {
    lines.push('');
    for (const note of value.notes) lines.push(`(note: ${note})`);
  }

  return lines.join('\n');
}

/** Strip diff path prefixes, `/dev/null`, and git quoting. */
function stripDiffPath(raw) {
  let value = raw.replace(/\t$/, '').trimEnd();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch {
      value = value.slice(1, -1);
    }
  }
  if (value === '/dev/null') return '/dev/null';
  if (value.startsWith('a/') || value.startsWith('b/')) return value.slice(2);
  return value;
}

/** Recover a file path from a `diff --git` header when no `+++` line exists. */
function pathFromHeader(line) {
  const rest = line.slice('diff --git '.length);
  const quoted = /^"a\/(.+)" "b\/(.+)"$/.exec(rest);
  if (quoted) return stripDiffPath(`"${quoted[2]}"`);
  const unquoted = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return unquoted ? unquoted[2] : null;
}

/** Split a unified diff into per-file blocks with line statistics. */
function parseDiff(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) blocks.push(current);
      current = { path: null, oldPath: null, header: line, lines: [line], additions: 0, deletions: 0 };
      continue;
    }
    if (current === null) continue;
    current.lines.push(line);
    if (line.startsWith('--- ')) {
      current.oldPath = stripDiffPath(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      current.path = stripDiffPath(line.slice(4));
    } else if (line.startsWith('+')) {
      current.additions += 1;
    } else if (line.startsWith('-')) {
      current.deletions += 1;
    }
  }
  if (current) blocks.push(current);

  return blocks
    .map((block) => {
      const path = block.path !== null && block.path !== '/dev/null'
        ? block.path
        : (block.oldPath !== null && block.oldPath !== '/dev/null' ? block.oldPath : pathFromHeader(block.header));
      return {
        path: path === null || path === '/dev/null' ? '(unknown file)' : path,
        additions: block.additions,
        deletions: block.deletions,
        text: block.lines.join('\n'),
      };
    })
    .filter((block) => block.path !== '(unknown file)' || block.additions + block.deletions > 0);
}

/** Match a repository path against the caller's path filters. */
function matchesPathFilter(filePath, filters) {
  return filters.some((raw) => {
    const filter = String(raw).trim().replace(/^\.?\//, '');
    if (filter.length === 0) return true;
    if (filter.includes('*')) {
      const pattern = filter
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${pattern}$`).test(filePath) || new RegExp(`^${pattern}/`).test(filePath);
    }
    return filePath === filter || filePath.startsWith(filter.endsWith('/') ? filter : `${filter}/`);
  });
}

/**
 * Read the diff of a pull request or of a branch comparison.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} args - tool arguments.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} model-facing value.
 */
export async function readDiff(config, args, signal) {
  const prInput = args.pr !== undefined && String(args.pr).trim().length > 0 ? args.pr : null;
  const base = typeof args.base === 'string' ? args.base.trim() : '';
  const head = typeof args.head === 'string' ? args.head.trim() : '';

  if (prInput !== null && (base.length > 0 || head.length > 0)) {
    throw new Error('pass either pr or base+head, not both.');
  }
  if (prInput === null && (base.length === 0 || head.length === 0)) {
    throw new Error('pass pr, or both base and head.');
  }

  const pullRef = prInput === null ? null : parsePull(prInput);
  const repo = resolveRepo(args.repo, config, pullRef?.repo);

  let diff;
  let label;
  if (pullRef !== null) {
    diff = (await ghCommand(config, ['pr', 'diff', String(pullRef.number), '--repo', repo], { signal })).stdout;
    label = `PR #${pullRef.number}`;
  } else {
    const comparison = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    diff = await apiText(config, `repos/${repo}/compare/${comparison}`, {
      accept: 'application/vnd.github.diff',
      signal,
    });
    label = `${base}...${head}`;
  }

  const filters = Array.isArray(args.paths) ? args.paths.filter((path) => String(path).trim().length > 0) : [];
  const blocks = parseDiff(diff);
  const selected = filters.length === 0 ? blocks : blocks.filter((block) => matchesPathFilter(block.path, filters));

  const combined = selected.map((block) => block.text).join('\n');
  const totalChars = combined.length;

  const requestedMax = Number.isInteger(args.max_chars) && args.max_chars > 0 ? args.max_chars : config.maxOutputChars;
  const maxChars = Math.min(requestedMax, config.maxOutputChars);
  const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
  if (offset > totalChars) {
    throw new Error(`offset ${offset} is past the end of this diff (${totalChars} characters).`);
  }
  const end = Math.min(totalChars, offset + maxChars);

  return {
    repo,
    label,
    kind: pullRef !== null ? 'pull' : 'compare',
    files: selected.map((block) => ({
      path: block.path,
      additions: block.additions,
      deletions: block.deletions,
    })),
    total_files: blocks.length,
    total_chars: totalChars,
    offset,
    next_offset: end < totalChars ? end : null,
    text: combined.slice(offset, end),
  };
}

/**
 * Render a `github_diff` value as model-facing text.
 *
 * @param {object} value - the tool output value.
 * @returns {string}
 */
export function renderDiff(value) {
  const lines = [`# ${value.repo} · ${value.label}`];
  const shown = value.files.length;
  lines.push(`${value.total_files} file${value.total_files === 1 ? '' : 's'} in the diff · ${shown} shown · ${value.total_chars} characters`);

  // A paged diff already spends its budget on text, so keep the stat list short.
  const statLimit = value.next_offset !== null ? 10 : 100;
  if (shown === 0) {
    lines.push('(no files matched the requested paths)');
  } else {
    lines.push('');
    for (const file of value.files.slice(0, statLimit)) {
      lines.push(` ${file.path} (+${file.additions} -${file.deletions})`);
    }
    if (shown > statLimit) lines.push(` (${shown - statLimit} more files)`);
  }

  if (value.text.length > 0) {
    lines.push('', '```diff', value.text, '```');
  }
  if (value.next_offset !== null) {
    lines.push(
      `(characters ${value.offset}-${value.offset + value.text.length} of ${value.total_chars}; call github_diff again with offset=${value.next_offset}, or use paths to narrow the diff.)`,
    );
  }
  return lines.join('\n');
}

/**
 * Validate and resolve a pull request creation request without writing.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} args - tool arguments.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} normalized request.
 */
export async function preparePullRequest(config, args, signal) {
  const repo = resolveRepo(args.repo, config);
  const title = String(args.title ?? '').trim();
  if (title.length === 0) throw new Error('title is required.');
  if (title.length > 256) throw new Error('title must be at most 256 characters.');

  const head = String(args.head ?? '').trim();
  if (head.length === 0) {
    throw new Error('head is required: it must name a branch that already exists on the remote.');
  }

  const body = typeof args.body === 'string' ? args.body : '';
  if (body.length > 65_536) throw new Error('body must be at most 65536 characters.');

  let base = typeof args.base === 'string' ? args.base.trim() : '';
  if (base.length === 0) {
    const info = await apiJson(config, `repos/${repo}`, { signal });
    base = typeof info?.default_branch === 'string' ? info.default_branch : '';
    if (base.length === 0) throw new Error(`Could not resolve the default branch of ${repo}; pass base explicitly.`);
  }

  return { repo, title, body, head, base, draft: args.draft === true };
}

/**
 * Create the prepared pull request.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} prepared - result of {@link preparePullRequest}.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} model-facing value.
 */
export async function submitPullRequest(config, prepared, signal) {
  const payload = {
    title: prepared.title,
    head: prepared.head,
    base: prepared.base,
    draft: prepared.draft,
  };
  if (prepared.body.trim().length > 0) payload.body = prepared.body;

  const created = await apiJson(config, `repos/${prepared.repo}/pulls`, {
    method: 'POST',
    input: payload,
    signal,
  });
  if (!created || !Number.isFinite(created.number)) {
    throw new Error('GitHub accepted the request but returned no pull request number.');
  }

  return {
    repo: prepared.repo,
    number: created.number,
    url: created.html_url ?? '',
    title: created.title ?? prepared.title,
    state: String(created.state ?? 'open').toUpperCase(),
    draft: Boolean(created.draft),
    base: created.base?.ref ?? prepared.base,
    head: created.head?.ref ?? prepared.head,
    created: true,
  };
}

/**
 * Render a created pull request as model-facing text.
 *
 * @param {object} value - the tool output value.
 * @returns {string}
 */
export function renderPullCreated(value) {
  const flags = [`state ${String(value.state).toLowerCase()}`];
  if (value.draft) flags.push('draft');
  return [
    `Opened ${value.repo} #${value.number} — ${value.title}`,
    `${flags.join(' · ')} · ${value.base} ← ${value.head}`,
    value.url,
  ].filter((line) => line.length > 0).join('\n');
}
