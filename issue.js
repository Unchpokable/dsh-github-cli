/**
 * Issue creation: validation, one REST call, and the approval summary shown
 * before anything is written.
 */

import { apiJson, resolveRepo } from './gh.js';

const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 65_536;
const MAX_LABELS = 20;
const MAX_ASSIGNEES = 10;

function stringList(value, label, limit, pattern) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings.`);
  if (value.length > limit) throw new Error(`${label} accepts at most ${limit} entries.`);

  const seen = new Set();
  const output = [];
  for (const entry of value) {
    const item = String(entry).trim();
    if (item.length === 0) throw new Error(`${label} entries must be non-empty.`);
    if (pattern && !pattern.test(item)) throw new Error(`${label} entry "${item}" is not a valid GitHub login or label.`);
    if (seen.has(item)) continue;
    seen.add(item);
    output.push(item);
  }
  return output;
}

/**
 * Validate an issue creation request without touching the network.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} args - tool arguments.
 * @returns {object} normalized request.
 */
export function prepareIssue(config, args) {
  const repo = resolveRepo(args.repo, config);

  const title = String(args.title ?? '').trim();
  if (title.length === 0) throw new Error('title is required.');
  if (title.length > MAX_TITLE_CHARS) throw new Error(`title must be at most ${MAX_TITLE_CHARS} characters.`);

  const body = typeof args.body === 'string' ? args.body : '';
  if (body.length > MAX_BODY_CHARS) throw new Error(`body must be at most ${MAX_BODY_CHARS} characters.`);

  const labels = stringList(args.labels, 'labels', MAX_LABELS, null);
  const assignees = stringList(args.assignees, 'assignees', MAX_ASSIGNEES, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);

  let milestone = null;
  if (args.milestone !== undefined && args.milestone !== null) {
    if (!Number.isInteger(args.milestone) || args.milestone < 1) {
      throw new Error('milestone must be a positive milestone number.');
    }
    milestone = args.milestone;
  }

  return { repo, title, body, labels, assignees, milestone };
}

/**
 * Create the prepared issue.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} prepared - result of {@link prepareIssue}.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} model-facing value.
 */
export async function submitIssue(config, prepared, signal) {
  const payload = { title: prepared.title };
  if (prepared.body.trim().length > 0) payload.body = prepared.body;
  if (prepared.labels.length > 0) payload.labels = prepared.labels;
  if (prepared.assignees.length > 0) payload.assignees = prepared.assignees;
  if (prepared.milestone !== null) payload.milestone = prepared.milestone;

  const created = await apiJson(config, `repos/${prepared.repo}/issues`, {
    method: 'POST',
    input: payload,
    signal,
  });
  if (!created || !Number.isFinite(created.number)) {
    throw new Error('GitHub accepted the request but returned no issue number.');
  }

  return {
    repo: prepared.repo,
    number: created.number,
    url: typeof created.html_url === 'string' ? created.html_url : '',
    title: typeof created.title === 'string' ? created.title : prepared.title,
    state: String(created.state ?? 'open').toUpperCase(),
    labels: Array.isArray(created.labels)
      ? created.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter((name) => typeof name === 'string')
      : [],
    created: true,
  };
}

/**
 * Human-readable summary for the approval prompt.
 *
 * @param {object} prepared - result of {@link prepareIssue}.
 * @returns {string}
 */
export function describeIssue(prepared) {
  const lines = [
    'Open an issue on GitHub.',
    '',
    `Repository: ${prepared.repo}`,
    `Title: ${prepared.title}`,
  ];
  if (prepared.labels.length > 0) lines.push(`Labels: ${prepared.labels.join(', ')}`);
  if (prepared.assignees.length > 0) lines.push(`Assignees: ${prepared.assignees.join(', ')}`);
  if (prepared.milestone !== null) lines.push(`Milestone: ${prepared.milestone}`);
  if (prepared.body.trim().length > 0) {
    const preview = prepared.body.length > 1200 ? `${prepared.body.slice(0, 1200)}\n[...]` : prepared.body;
    lines.push('', 'Body:', preview);
  }
  return lines.join('\n');
}

/**
 * Render a created issue as model-facing text.
 *
 * @param {object} value - the tool output value.
 * @returns {string}
 */
export function renderIssueCreated(value) {
  const lines = [
    `Opened ${value.repo} #${value.number} — ${value.title}`,
    `state ${String(value.state).toLowerCase()}${value.labels.length > 0 ? ` · labels: ${value.labels.join(', ')}` : ''}`,
  ];
  if (value.url) lines.push(value.url);
  return lines.join('\n');
}
