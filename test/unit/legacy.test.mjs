import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStatus } from '../../index.js';
import { parseCoAuthors } from '../../pr.js';
import { prepareReview } from '../../review.js';
import { prepareIssue } from '../../issue.js';
import { parseRepo } from '../../gh.js';

const config = {
  defaultRepo: 'owner/repo',
  maxOutputChars: 80_000,
  timeoutMs: 60_000,
};

test('legacy renderStatus keeps the original first line', () => {
  const text = renderStatus({
    found: true,
    path: '/usr/bin/gh',
    version: '2.80.0',
    source: 'PATH',
    authenticated: true,
    host: 'github.com',
    account: 'octocat',
    scopes: ['repo'],
    rate_limit: { remaining: 10, limit: 5000, reset_at: null },
  });
  assert.equal(text.split('\n')[0], 'GitHub CLI 2.80.0 at /usr/bin/gh (found on PATH)');
  assert.match(text, /authenticated: yes — github\.com\/octocat/);
  assert.match(text, /token scopes: repo/);
});

test('legacy PR helpers still parse co-authors and review ranges', () => {
  const names = parseCoAuthors('Subject\n\nCo-authored-by: A <a@example.com>\nCo-Authored-By: B <b@example.com>');
  assert.deepEqual(names, ['A', 'B']);

  const review = prepareReview(config, {
    repo: 'owner/repo',
    pr: '7',
    event: 'COMMENT',
    body: 'Note',
    comments: [{ path: 'file.txt', line: 10, start_line: 4, body: 'range' }],
  });
  assert.equal(review.comments[0].start_line, 4);
  assert.equal(review.comments[0].start_side, 'RIGHT');
});

test('legacy issue helper keeps validation and dedupe behavior', () => {
  const issue = prepareIssue(config, {
    repo: 'owner/repo',
    title: 'Title',
    labels: ['bug', 'bug', 'help wanted'],
    assignees: ['octocat'],
    milestone: 2,
  });
  assert.deepEqual(issue.labels, ['bug', 'help wanted']);
  assert.deepEqual(issue.assignees, ['octocat']);
  assert.equal(issue.milestone, 2);
});

test('legacy parseRepo keeps defaultRepo and URL behavior', () => {
  assert.equal(parseRepo(undefined, config), 'owner/repo');
  assert.equal(parseRepo('https://github.com/owner/repo', config), 'owner/repo');
  assert.throws(() => parseRepo(undefined, {}), /repo is required/);
});
