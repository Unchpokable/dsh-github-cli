/**
 * Pull request reviews: validation, and one atomic review submission carrying
 * an optional summary body plus inline comments.
 *
 * The review endpoint attaches every inline comment in a single request, so a
 * code review costs one API call instead of one per comment.
 */

import { apiJson, parsePull, resolveRepo, shortSha } from './gh.js';

const EVENTS = new Set(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
const MAX_INLINE_COMMENTS = 50;
const MAX_TEXT_CHARS = 65_536;

function validateSide(value, label) {
  if (value === undefined || value === null) return null;
  const side = String(value).trim().toUpperCase();
  if (side !== 'RIGHT' && side !== 'LEFT') {
    throw new Error(`${label} must be RIGHT or LEFT.`);
  }
  return side;
}

function validateComment(entry, index) {
  const label = `comments[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${label} must be an object.`);
  }

  const path = String(entry.path ?? '').trim().replace(/^\.?\//, '');
  if (path.length === 0) throw new Error(`${label}.path is required.`);

  const body = typeof entry.body === 'string' ? entry.body : '';
  if (body.trim().length === 0) throw new Error(`${label}.body is required.`);
  if (body.length > MAX_TEXT_CHARS) throw new Error(`${label}.body must be at most ${MAX_TEXT_CHARS} characters.`);

  if (!Number.isInteger(entry.line) || entry.line < 1) {
    throw new Error(`${label}.line must be a positive line number in the pull request diff.`);
  }

  const side = validateSide(entry.side, `${label}.side`) ?? 'RIGHT';
  const comment = { path, body, line: entry.line, side };

  if (entry.start_line !== undefined && entry.start_line !== null) {
    if (!Number.isInteger(entry.start_line) || entry.start_line < 1) {
      throw new Error(`${label}.start_line must be a positive line number.`);
    }
    if (entry.start_line > entry.line) {
      throw new Error(`${label}.start_line must not be after line.`);
    }
    if (entry.start_line < entry.line) {
      comment.start_line = entry.start_line;
      comment.start_side = validateSide(entry.start_side, `${label}.start_side`) ?? side;
    }
  }

  return comment;
}

/**
 * Validate a review request without touching the network.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} args - tool arguments.
 * @returns {object} normalized review request.
 */
export function prepareReview(config, args) {
  const pullRef = parsePull(args.pr);
  const repo = resolveRepo(args.repo, config, pullRef.repo);

  const rawEvent = typeof args.event === 'string' && args.event.trim().length > 0 ? args.event.trim().toUpperCase() : 'COMMENT';
  if (!EVENTS.has(rawEvent)) {
    throw new Error(`event must be COMMENT, APPROVE, or REQUEST_CHANGES; got "${args.event}".`);
  }

  const body = typeof args.body === 'string' ? args.body : '';
  if (body.length > MAX_TEXT_CHARS) throw new Error(`body must be at most ${MAX_TEXT_CHARS} characters.`);

  const rawComments = Array.isArray(args.comments) ? args.comments : [];
  if (rawComments.length > MAX_INLINE_COMMENTS) {
    throw new Error(`comments accepts at most ${MAX_INLINE_COMMENTS} inline comments per review.`);
  }
  const comments = rawComments.map((entry, index) => validateComment(entry, index));

  if (body.trim().length === 0 && comments.length === 0) {
    throw new Error('a review needs a body or at least one inline comment.');
  }

  return {
    repo,
    number: pullRef.number,
    event: rawEvent,
    body,
    comments,
    dryRun: args.dry_run === true,
  };
}

/**
 * Resolve the pull request a review would attach to.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} prepared - result of {@link prepareReview}.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} target facts.
 */
export async function loadReviewTarget(config, prepared, signal) {
  const pull = await apiJson(config, `repos/${prepared.repo}/pulls/${prepared.number}`, { signal });
  const headSha = pull?.head?.sha;
  if (typeof headSha !== 'string' || headSha.length === 0) {
    throw new Error(`Could not resolve the head commit of ${prepared.repo} pull request #${prepared.number}.`);
  }
  return {
    title: typeof pull.title === 'string' ? pull.title : '',
    headSha,
    url: typeof pull.html_url === 'string' ? pull.html_url : '',
    state: String(pull.state ?? 'unknown').toUpperCase(),
    base: pull.base?.ref ?? null,
    head: pull.head?.ref ?? null,
  };
}

/**
 * The request body for the review endpoint.
 *
 * @param {object} prepared - normalized review request.
 * @param {object} target - result of {@link loadReviewTarget}.
 * @returns {object}
 */
export function buildReviewPayload(prepared, target) {
  const payload = { commit_id: target.headSha, event: prepared.event };
  if (prepared.body.trim().length > 0) payload.body = prepared.body;
  if (prepared.comments.length > 0) payload.comments = prepared.comments;
  return payload;
}

/**
 * Submit the review.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} prepared - normalized review request.
 * @param {object} target - resolved pull request facts.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} model-facing value.
 */
export async function submitReview(config, prepared, target, signal) {
  const created = await apiJson(config, `repos/${prepared.repo}/pulls/${prepared.number}/reviews`, {
    method: 'POST',
    input: buildReviewPayload(prepared, target),
    signal,
  });

  return {
    repo: prepared.repo,
    number: prepared.number,
    title: target.title,
    url: typeof created?.html_url === 'string' ? created.html_url : target.url,
    state: String(created?.state ?? prepared.event).toUpperCase(),
    event: prepared.event,
    review_id: Number.isFinite(created?.id) ? created.id : null,
    commit: shortSha(target.headSha),
    inline_comments: prepared.comments.length,
    body_chars: prepared.body.length,
    posted: true,
    dry_run: false,
    body: null,
    comments: [],
  };
}

/**
 * A dry-run value showing exactly what would be posted.
 *
 * @param {object} prepared - normalized review request.
 * @param {object} target - resolved pull request facts.
 * @param {string} reason - why posting cannot proceed, or empty when only previewing.
 * @returns {object} model-facing value.
 */
export function previewReview(prepared, target, reason = '') {
  return {
    repo: prepared.repo,
    number: prepared.number,
    title: target.title,
    url: target.url,
    state: String(target.state ?? 'unknown').toUpperCase(),
    event: prepared.event,
    review_id: null,
    commit: shortSha(target.headSha),
    inline_comments: prepared.comments.length,
    body_chars: prepared.body.length,
    posted: false,
    dry_run: true,
    body: prepared.body,
    comments: prepared.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      start_line: comment.start_line ?? null,
      start_side: comment.start_side ?? null,
      body: comment.body,
    })),
    reason,
  };
}

/**
 * Human-readable summary for the approval prompt.
 *
 * @param {object} prepared - normalized review request.
 * @param {object} target - resolved pull request facts.
 * @returns {string}
 */
export function describeReview(prepared, target) {
  const lines = [
    'Submit a pull request review on GitHub.',
    '',
    `Repository: ${prepared.repo}`,
    `Pull request: #${prepared.number} — ${target.title || '(no title)'}`,
    `Verdict: ${prepared.event}`,
    `Commit: ${shortSha(target.headSha)}`,
    `Inline comments: ${prepared.comments.length}`,
  ];

  if (prepared.body.trim().length > 0) {
    const preview = prepared.body.length > 1200 ? `${prepared.body.slice(0, 1200)}\n[...]` : prepared.body;
    lines.push('', 'Review body:', preview);
  }
  for (const [index, comment] of prepared.comments.slice(0, 5).entries()) {
    const body = comment.body.length > 180 ? `${comment.body.slice(0, 180)}[...]` : comment.body;
    const side = comment.start_side ? `${comment.start_side}→${comment.side}` : comment.side;
    lines.push('', `Inline ${index + 1}: ${comment.path}:${comment.line} (${side})`, body);
  }
  if (prepared.comments.length > 5) lines.push('', `... and ${prepared.comments.length - 5} more inline comments`);
  return lines.join('\n');
}

/**
 * Render a `github_review` value as model-facing text.
 *
 * @param {object} value - the tool output value.
 * @returns {string}
 */
export function renderReview(value) {
  const lines = [];
  if (value.dry_run) {
    lines.push(`Dry run — nothing was posted to ${value.repo} #${value.number}.`);
    lines.push(`${value.event} · commit ${value.commit} · ${value.inline_comments} inline comments`);
    if (value.title) lines.push(`Title: ${value.title}`);
    if (value.reason) lines.push(`Reason: ${value.reason}`);
    if (value.body) lines.push('', 'Body:', value.body);
    if (value.comments.length > 0) {
      lines.push('', 'Inline comments:');
      for (const comment of value.comments) {
        const range = comment.start_line !== null ? `${comment.start_line}-${comment.line}` : `${comment.line}`;
        const side = comment.start_side ? `${comment.start_side}→${comment.side}` : comment.side;
        lines.push(`- ${comment.path}:${range} (${side})`);
        lines.push(`  ${comment.body.split('\n')[0]}`);
      }
    }
    return lines.join('\n');
  }

  lines.push(`Posted ${value.event} review on ${value.repo} #${value.number}${value.review_id !== null ? ` (review ${value.review_id})` : ''}.`);
  lines.push(`commit ${value.commit} · ${value.inline_comments} inline comments`);
  if (value.url) lines.push(value.url);
  return lines.join('\n');
}

/**
 * Human-readable summary for the approval prompt of a new pull request.
 *
 * @param {object} prepared - result of `preparePullRequest`.
 * @returns {string}
 */
export function describePullRequest(prepared) {
  const lines = [
    'Open a pull request on GitHub.',
    '',
    `Repository: ${prepared.repo}`,
    `Base: ${prepared.base} ← head: ${prepared.head}`,
    `Draft: ${prepared.draft ? 'yes' : 'no'}`,
    `Title: ${prepared.title}`,
  ];
  if (prepared.body.trim().length > 0) {
    const preview = prepared.body.length > 1200 ? `${prepared.body.slice(0, 1200)}\n[...]` : prepared.body;
    lines.push('', 'Body:', preview);
  }
  return lines.join('\n');
}
