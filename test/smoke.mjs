/**
 * Live smoke tests for the GitHub CLI plugin.
 *
 * These call the real GitHub API through the signed-in `gh` account. They only
 * read; the review test runs in dry-run mode, so nothing is posted.
 *
 *   node test/smoke.mjs
 */

import { readStatus, renderStatus } from '../index.js';
import { resolveGh } from '../gh.js';
import { readRepository, renderRead } from '../read.js';
import { readDiff, readPull, renderDiff, renderPull, preparePullRequest } from '../pr.js';
import { loadReviewTarget, prepareReview, previewReview, renderReview } from '../review.js';
import { describeIssue, prepareIssue } from '../issue.js';

const config = {
  ghPath: '',
  defaultRepo: 'untodesu/dsh-github-cli',
  maxOutputChars: 80_000,
  timeoutMs: 60_000,
  requireApproval: true,
};

const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL  ${name}: ${error.message}`);
  }
}

function preview(value, length = 500) {
  const text = renderRead(value);
  return text.length > length ? `${text.slice(0, length)}\n[...]` : text;
}

await test('resolveGh finds the installed CLI', async () => {
  const executable = await resolveGh(config);
  assert(executable.path.length > 0, 'empty path');
  assert(/^\d+\./.test(executable.version), `unexpected version ${executable.version}`);
  console.log(`      ${executable.version} at ${executable.path} (${executable.source})`);
});

await test('github_status reports the signed-in account', async () => {
  const value = await readStatus(config);
  assert(value.found === true, 'gh not found');
  assert(value.authenticated === true, 'not authenticated');
  assert(value.account === 'untodesu', `unexpected account ${value.account}`);
  assert(value.rate_limit && value.rate_limit.limit === 5000, 'missing rate limit');
  console.log(`      ${renderStatus(value).split('\n').slice(0, 3).join(' | ')}`);
});

await test('github_read reads one file', async () => {
  const value = await readRepository(config, { repo: 'octocat/Hello-World', path: 'README' }, undefined);
  assert(value.files.length === 1, `expected one file, got ${value.files.length}`);
  assert(value.files[0].content.includes('Hello World'), 'unexpected README content');
  assert(value.files[0].total_lines >= 1, 'missing line count');
  console.log(`      ${preview(value).split('\n').slice(0, 3).join(' | ')}`);
});

await test('github_read lists a directory', async () => {
  const value = await readRepository(config, { repo: 'octocat/Hello-World' }, undefined);
  assert(value.entries.length > 0, 'no entries');
  assert(value.entries.some((entry) => entry.path === 'README'), 'README missing from listing');
  console.log(`      ${preview(value).split('\n')[0]}`);
});

await test('github_read lists a directory recursively', async () => {
  const value = await readRepository(config, { repo: 'cli/cli', path: 'docs', recursive: true }, undefined);
  assert(value.entries.length > 0, 'no tree entries');
  assert(value.entries.every((entry) => entry.path.startsWith('docs/')), 'tree escaped the requested directory');
  console.log(`      ${preview(value).split('\n')[0]}`);
});

await test('github_read reads several paths at one ref', async () => {
  const value = await readRepository(
    config,
    { repo: 'cli/cli', ref: 'trunk', paths: ['README.md', 'go.mod', 'docs/README.md'] },
    undefined,
  );
  assert(value.files.length === 3, `expected three files, got ${value.files.length}`);
  assert(value.files[0].path === 'README.md', 'unexpected first path');
  assert(value.files[1].content.includes('module'), 'go.mod content missing');
  console.log(`      ${value.files.map((file) => `${file.path} (${file.total_lines} lines)`).join(', ')}`);
});

await test('github_read respects a line range', async () => {
  const value = await readRepository(config, { repo: 'cli/cli', path: 'README.md', start_line: 2, end_line: 4 }, undefined);
  const file = value.files[0];
  assert(file.start_line === 2 && file.end_line === 4, `unexpected range ${file.start_line}-${file.end_line}`);
  assert(file.content.split('\n').length === 3, 'unexpected line count');
  console.log(`      ${file.content.split('\n')[0].slice(0, 60)}`);
});

await test('github_read clips output to the configured budget', async () => {
  const small = { ...config, maxOutputChars: 2_000 };
  const value = await readRepository(small, { repo: 'cli/cli', path: 'README.md' }, undefined);
  assert(value.truncated === true, 'expected truncation');
  assert(renderRead(value).length < 4_000, 'rendered output exceeded the budget');
  console.log(`      ${value.files[0].end_line} of ${value.files[0].total_lines} lines shown`);
});

await test('github_read reads a pull request head', async () => {
  const value = await readRepository(config, { repo: 'cli/cli', pr: '1', path: 'README.md' }, undefined);
  assert(value.revision !== null && value.revision.length === 40, 'head sha not reported');
  assert(value.ref.startsWith('PR #1 head'), `unexpected ref label ${value.ref}`);
  assert(value.files[0].content.length > 0, 'no content at the PR head');
  console.log(`      ${value.ref}`);
});

await test('github_read reports a missing path clearly', async () => {
  let message = '';
  try {
    await readRepository(config, { repo: 'cli/cli', path: 'no/such/file.txt' }, undefined);
  } catch (error) {
    message = error.message;
  }
  assert(message.includes('404'), `unexpected error: ${message}`);
});

await test('github_pr reads metadata, files, comments, commits, and checks', async () => {
  const value = await readPull(
    config,
    { repo: 'cli/cli', pr: '1', include: ['description', 'files', 'comments', 'commits', 'checks'] },
    undefined,
  );
  assert(value.number === 1, 'wrong PR number');
  assert(value.title.length > 0, 'missing title');
  assert(value.files !== null && value.files.items.length > 0, 'no files');
  assert(value.comments !== null, 'comments section missing');
  assert(value.commits !== null && value.commits.items.length > 0, 'no commits');
  assert(Array.isArray(value.notes), 'notes missing');
  const rendered = renderPull(value);
  assert(rendered.includes('## Description'), 'description section missing');
  console.log(`      ${value.files.items.length} files, ${value.comments.total} comments, ${value.commits.total} commits`);
});

await test('github_diff reads a pull request diff', async () => {
  const value = await readDiff(config, { repo: 'cli/cli', pr: '1' }, undefined);
  assert(value.total_files > 0, 'no files in diff');
  assert(value.text.length > 0, 'empty diff text');
  assert(value.kind === 'pull', 'wrong diff kind');
  const rendered = renderDiff(value);
  assert(rendered.includes('```diff'), 'diff fence missing');
  console.log(`      ${value.total_files} files, ${value.total_chars} chars`);
});

await test('github_diff filters by path', async () => {
  const all = await readDiff(config, { repo: 'cli/cli', pr: '1' }, undefined);
  const first = all.files[0]?.path;
  assert(typeof first === 'string', 'no first file');
  const filtered = await readDiff(config, { repo: 'cli/cli', pr: '1', paths: [first] }, undefined);
  assert(filtered.total_files > 0, 'filter matched nothing');
  assert(filtered.files.every((file) => file.path === first), 'filter leaked other files');
  console.log(`      ${first}`);
});

await test('github_diff compares two refs', async () => {
  const value = await readDiff(config, { repo: 'cli/cli', base: 'trunk', head: 'trunk' }, undefined);
  assert(value.kind === 'compare', 'wrong diff kind');
  assert(value.total_files === 0, `expected an empty diff, got ${value.total_files}`);
  assert(renderDiff(value).includes('no files matched'), 'empty diff not explained');
});

await test('github_diff pages with offset', async () => {
  const value = await readDiff(config, { repo: 'cli/cli', pr: '1', max_chars: 300 }, undefined);
  assert(value.text.length === 300, 'unexpected page size');
  assert(value.next_offset === 300, `unexpected next offset ${value.next_offset}`);
  const next = await readDiff(config, { repo: 'cli/cli', pr: '1', max_chars: 300, offset: value.next_offset }, undefined);
  assert(next.offset === 300, 'offset not applied');
  assert(next.text !== value.text, 'second page repeated the first');
});

await test('github_review validates and previews without posting', async () => {
  const prepared = prepareReview(config, {
    repo: 'cli/cli',
    pr: '1',
    event: 'COMMENT',
    body: 'Smoke test body.',
    comments: [
      { path: 'command/pr.go', line: 1, body: 'First line note.' },
      { path: 'command/pr.go', line: 10, start_line: 4, body: 'Range note.' },
    ],
    dry_run: true,
  });
  const target = await loadReviewTarget(config, prepared);
  const value = previewReview(prepared, target);
  assert(value.posted === false, 'dry run posted something');
  assert(value.inline_comments === 2, 'inline comments lost');
  assert(value.commit.length === 7, 'commit not shortened');
  const rendered = renderReview(value);
  assert(rendered.includes('Dry run'), 'dry run not announced');
  assert(rendered.includes('command/pr.go:4-10'), 'comment range preview missing');
  assert(rendered.includes('First line note.'), 'comment body preview missing');
  console.log(`      ${rendered.split('\n')[0]}`);
});

await test('github_review rejects an empty review', async () => {
  let failed = false;
  try {
    prepareReview(config, { repo: 'cli/cli', pr: '1' });
  } catch {
    failed = true;
  }
  assert(failed, 'empty review was accepted');
});

await test('github_review rejects an unterminated line range', async () => {
  let failed = false;
  try {
    prepareReview(config, {
      repo: 'cli/cli',
      pr: '1',
      comments: [{ path: 'x', line: 2, start_line: 5, body: 'bad' }],
    });
  } catch {
    failed = true;
  }
  assert(failed, 'inverted range was accepted');
});

await test('github_pr_create resolves the default base branch', async () => {
  const prepared = await preparePullRequest(config, { repo: 'octocat/Hello-World', title: 'Smoke test', head: 'no-such-branch' }, undefined);
  assert(prepared.base === 'master' || prepared.base === 'main', `unexpected base ${prepared.base}`);
  assert(prepared.head === 'no-such-branch', 'head lost');
  console.log(`      base ${prepared.base}`);
});

await test('github_issue_create validates labels, assignees, and milestone', async () => {
  const prepared = prepareIssue(config, {
    repo: 'octocat/Hello-World',
    title: 'Smoke test issue',
    body: 'Body text.',
    labels: ['bug', 'bug', 'help wanted'],
    assignees: ['untodesu'],
    milestone: 1,
  });
  assert(prepared.labels.length === 2, `labels not deduplicated: ${prepared.labels.join(',')}`);
  assert(prepared.assignees[0] === 'untodesu', 'assignee lost');
  assert(prepared.milestone === 1, 'milestone lost');
  const summary = describeIssue(prepared);
  assert(summary.includes('Labels: bug, help wanted'), 'labels missing from approval summary');
  assert(summary.includes('Assignees: untodesu'), 'assignees missing from approval summary');

  let failed = false;
  try {
    prepareIssue(config, { repo: 'octocat/Hello-World', title: 'Test', assignees: ['not a login'] });
  } catch {
    failed = true;
  }
  assert(failed, 'invalid assignee was accepted');

  failed = false;
  try {
    prepareIssue(config, { repo: 'octocat/Hello-World', title: '   ' });
  } catch {
    failed = true;
  }
  assert(failed, 'empty title was accepted');
});

await test('github_pr renders inline comment ranges', async () => {
  const value = {
    repo: 'owner/repo',
    number: 1,
    title: 'Title',
    url: '',
    state: 'OPEN',
    draft: false,
    merged: false,
    author: 'someone',
    base: 'main',
    head: 'branch',
    head_sha: '1234567890abcdef',
    additions: 0,
    deletions: 0,
    changed_files: 0,
    commit_count: 0,
    comment_count: 0,
    review_comment_count: 0,
    created_at: null,
    updated_at: null,
    body: null,
    body_truncated: false,
    files: null,
    commits: null,
    checks: null,
    notes: [],
    comments: {
      items: [{
        kind: 'inline',
        author: 'someone',
        created_at: null,
        body: 'note',
        path: 'file.md',
        line: 11,
        start_line: 10,
        state: null,
        body_truncated: false,
      }],
      total: 1,
      truncated: false,
    },
  };
  const rendered = renderPull(value);
  assert(rendered.includes('file.md:10-11'), 'comment range not rendered');
});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const result of failed) console.error(`\n${result.name}\n${result.error.stack ?? result.error.message}`);
  process.exitCode = 1;
}
