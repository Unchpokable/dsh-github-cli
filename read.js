/**
 * Repository reads: files, directory listings, and recursive trees at a branch,
 * tag, commit, or pull request head.
 *
 * One target costs one Contents API call (plus one blob call for a file that
 * the Contents API refuses to inline). Every returned text is bounded so a
 * single read cannot flood the conversation.
 */

import { apiJson, formatBytes, parsePull, resolveRepo, shortSha } from './gh.js';

const MAX_DIR_ENTRIES = 400;
const MAX_TREE_ENTRIES = 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_PATHS = 20;
const FETCH_CONCURRENCY = 4;

/** Render a repository path for the model. */
function displayPath(path) {
  return path === '' ? 'repository root' : path;
}

/** Encode a repository path for a REST URL without losing its separators. */
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Normalize and validate a repository-relative path. */
function normalizePath(input) {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) return '';
  const value = raw
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (value === '.' || value.length === 0) return '';
  if (value.split('/').some((segment) => segment === '..')) {
    throw new Error(`path must stay inside the repository: "${raw}".`);
  }
  return value;
}

function splitLines(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

async function fetchContents(config, repo, ref, path, signal) {
  const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const endpoint = `repos/${repo}/contents${path ? `/${encodePath(path)}` : ''}${suffix}`;
  return apiJson(config, endpoint, { signal });
}

async function fetchBlob(config, repo, sha, signal) {
  const blob = await apiJson(config, `repos/${repo}/git/blobs/${sha}`, { signal });
  if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error('GitHub returned a blob in an unsupported encoding.');
  }
  return Buffer.from(blob.content.replace(/\n/g, ''), 'base64');
}

/**
 * Resolve the revision named by `pr` into an immutable head SHA.
 *
 * @returns {Promise<{sha: string, branch: string, title: string}>}
 */
export async function pullHead(config, repo, number, signal) {
  const pull = await apiJson(config, `repos/${repo}/pulls/${number}`, { signal });
  const sha = pull?.head?.sha;
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new Error(`Could not resolve the head commit of ${repo} pull request #${number}.`);
  }
  return { sha, branch: pull.head.ref ?? 'unknown branch', title: pull.title ?? '' };
}

function listDirectory(data, path) {
  const entries = data.map((entry) => ({
    path: entry.path ?? `${path}/${entry.name}`,
    type: entry.type === 'dir' ? 'dir' : entry.type,
    size: Number.isFinite(entry.size) ? entry.size : null,
  }));
  entries.sort((left, right) => {
    const leftRank = left.type === 'dir' ? 0 : 1;
    const rightRank = right.type === 'dir' ? 0 : 1;
    return leftRank - rightRank || left.path.localeCompare(right.path);
  });
  return entries.slice(0, MAX_DIR_ENTRIES);
}

async function readTree(config, repo, ref, path, signal) {
  let tree;
  if (path === '') {
    let revision = ref;
    if (!revision) {
      const info = await apiJson(config, `repos/${repo}`, { signal });
      revision = info?.default_branch;
    }
    if (!revision) throw new Error(`Could not resolve the default branch of ${repo}.`);
    tree = await apiJson(config, `repos/${repo}/git/trees/${encodeURIComponent(revision)}?recursive=1`, { signal });
  } else {
    const slash = path.lastIndexOf('/');
    const parentPath = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const parent = await fetchContents(config, repo, ref, parentPath, signal);
    const directory = Array.isArray(parent)
      ? parent.find((entry) => entry.name === name && entry.type === 'dir')
      : undefined;
    if (!directory?.sha) throw new Error(`"${displayPath(path)}" is not a directory in ${repo}.`);
    tree = await apiJson(config, `repos/${repo}/git/trees/${directory.sha}?recursive=1`, { signal });
  }

  const prefix = path === '' ? '' : `${path}/`;
  const entries = (tree?.tree ?? [])
    .filter((entry) => entry.type === 'blob' || entry.type === 'commit')
    .map((entry) => ({
      path: `${prefix}${entry.path}`,
      type: entry.type === 'commit' ? 'submodule' : 'file',
      size: Number.isFinite(entry.size) ? entry.size : null,
    }));
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    entries: entries.slice(0, MAX_TREE_ENTRIES),
    files: [],
    omitted: [],
    notes: tree?.truncated ? ['GitHub truncated the recursive tree; narrow the path.'] : [],
    truncated: Boolean(tree?.truncated) || entries.length > MAX_TREE_ENTRIES,
  };
}

async function readFileEntry(config, repo, ref, path, data, range, signal) {
  const bytes = Number.isFinite(data.size) ? data.size : 0;
  const record = {
    path: displayPath(path),
    start_line: 1,
    end_line: 0,
    total_lines: 0,
    bytes,
    sha: typeof data.sha === 'string' ? data.sha : null,
    content: null,
    truncated: false,
    binary: false,
    too_large: false,
    note: null,
  };

  if (bytes > MAX_FILE_BYTES) {
    return {
      ...record,
      too_large: true,
      note: `file is ${formatBytes(bytes)}; this tool reads at most ${formatBytes(MAX_FILE_BYTES)} per file`,
    };
  }

  let buffer;
  if (typeof data.content === 'string' && data.content.length > 0 && data.encoding === 'base64') {
    buffer = Buffer.from(data.content.replace(/\n/g, ''), 'base64');
  } else if (bytes === 0) {
    buffer = Buffer.alloc(0);
  } else if (typeof data.sha === 'string') {
    buffer = await fetchBlob(config, repo, data.sha, signal);
  } else {
    buffer = Buffer.alloc(0);
  }

  const text = decodeText(buffer);
  if (text === null) {
    return { ...record, binary: true, note: 'binary file; content is not shown' };
  }

  const lines = splitLines(text);
  const total = lines.length;
  if (total === 0) {
    return { ...record, content: '', end_line: 0, total_lines: 0, note: 'empty file' };
  }

  const first = Math.min(Math.max(1, range.startLine ?? 1), total);
  const last = Math.min(total, Math.max(first, range.endLine ?? total));
  const selected = lines.slice(first - 1, last);
  return {
    ...record,
    start_line: first,
    end_line: last,
    total_lines: total,
    content: selected.join('\n'),
    note: first > 1 || last < total ? `showing lines ${first}-${last} of ${total}` : null,
  };
}

async function readOne(config, { repo, ref, path, recursive }, range, signal) {
  const data = await fetchContents(config, repo, ref, path, signal);

  if (Array.isArray(data)) {
    if (recursive) return readTree(config, repo, ref, path, signal);
    return {
      entries: listDirectory(data, path),
      files: [],
      omitted: [],
      notes: [],
      truncated: data.length > MAX_DIR_ENTRIES,
    };
  }

  if (data === null || typeof data !== 'object') {
    throw new Error(`No content found at "${displayPath(path)}" in ${repo}.`);
  }

  if (data.type === 'file') {
    return {
      entries: [],
      files: [await readFileEntry(config, repo, ref, path, data, range, signal)],
      omitted: [],
      notes: [],
      truncated: false,
    };
  }

  if (data.type === 'symlink') {
    return {
      entries: [{ path: displayPath(path), type: 'symlink', size: null }],
      files: [],
      omitted: [],
      notes: [`symlink to ${data.target ?? 'an unknown target'}`],
      truncated: false,
    };
  }

  if (data.type === 'submodule') {
    return {
      entries: [{ path: displayPath(path), type: 'submodule', size: null }],
      files: [],
      omitted: [],
      notes: [`submodule at ${data.submodule_git_url ?? 'an unknown URL'}`],
      truncated: false,
    };
  }

  throw new Error(`Unsupported repository entry type "${data.type}" at "${displayPath(path)}".`);
}

/** Run `task` over `items` with a fixed number of concurrent workers. */
async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fit one file into the remaining output budget.
 *
 * @returns the possibly clipped record, or null when nothing useful fits.
 */
function fitToBudget(record, budget) {
  if (record.content === null) {
    budget.remaining -= 200;
    return record;
  }
  if (record.content.length === 0) {
    budget.remaining -= 200;
    return record;
  }

  const lines = record.content.split('\n');
  const width = Math.max(3, String(record.end_line).length);
  const overhead = width + 4;
  let used = 0;
  let count = 0;
  for (const line of lines) {
    const cost = line.length + overhead + 1;
    if (used + cost > budget.remaining) break;
    used += cost;
    count += 1;
  }

  if (count === lines.length) {
    budget.remaining -= used;
    return record;
  }

  if (count === 0) {
    const room = budget.remaining - overhead - 1;
    if (room < 40) return null;
    budget.remaining = 0;
    return {
      ...record,
      content: lines[0].slice(0, room),
      end_line: record.start_line,
      truncated: true,
      note: appendNote(record.note, 'output limit reached mid-line; read the rest with start_line'),
    };
  }

  budget.remaining -= used;
  return {
    ...record,
    content: lines.slice(0, count).join('\n'),
    end_line: record.start_line + count - 1,
    truncated: true,
    note: appendNote(record.note, `output limit reached; continue from start_line ${record.start_line + count}`),
  };
}

function appendNote(note, addition) {
  return note ? `${note}; ${addition}` : addition;
}

/**
 * Read repository content for the `github_read` tool.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {object} args - tool arguments.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} model-facing value.
 */
export async function readRepository(config, args, signal) {
  const prInput = args.pr !== undefined && String(args.pr).trim().length > 0 ? args.pr : null;
  const refInput = typeof args.ref === 'string' ? args.ref.trim() : '';
  if (prInput !== null && refInput.length > 0) {
    throw new Error('pass either pr or ref, not both.');
  }

  const pullRef = prInput === null ? null : parsePull(prInput);
  const repo = resolveRepo(args.repo, config, pullRef?.repo);
  const revision = pullRef === null ? null : await pullHead(config, repo, pullRef.number, signal);
  const ref = revision?.sha ?? refInput;
  const refLabel = revision
    ? `PR #${pullRef.number} head · ${revision.branch} @ ${shortSha(revision.sha)}`
    : ref || 'default branch';

  const range = {
    startLine: Number.isInteger(args.start_line) ? args.start_line : null,
    endLine: Number.isInteger(args.end_line) ? args.end_line : null,
  };
  if (range.startLine !== null && range.startLine < 1) throw new Error('start_line must be a positive integer.');
  if (range.endLine !== null && range.endLine < 1) throw new Error('end_line must be a positive integer.');
  if (range.startLine !== null && range.endLine !== null && range.endLine < range.startLine) {
    throw new Error('end_line must be greater than or equal to start_line.');
  }

  const batch = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : null;
  if (batch !== null && args.path !== undefined) {
    throw new Error('pass either path or paths, not both.');
  }
  if (batch !== null && (range.startLine !== null || range.endLine !== null)) {
    throw new Error('start_line and end_line apply only to a single path.');
  }
  if (batch !== null && batch.length > MAX_BATCH_PATHS) {
    throw new Error(`paths accepts at most ${MAX_BATCH_PATHS} entries.`);
  }

  const targets = batch === null
    ? [normalizePath(args.path ?? '')]
    : [...new Set(batch.map((entry) => normalizePath(entry)))];
  if (targets.some((path) => path === '') && batch !== null) {
    throw new Error('paths entries must name files or directories, not the repository root.');
  }

  const records = await mapWithConcurrency(targets, FETCH_CONCURRENCY, async (path) => {
    return readOne(config, { repo, ref, path, recursive: args.recursive === true }, range, signal);
  });

  const budget = { remaining: config.maxOutputChars };
  const value = {
    repo,
    ref: refLabel,
    revision: revision?.sha ?? null,
    target: targets.length === 1 ? displayPath(targets[0]) : `${targets.length} paths`,
    recursive: args.recursive === true,
    entries: [],
    files: [],
    omitted: [],
    truncated: false,
    entries_truncated: false,
    notes: [],
  };

  for (const record of records) {
    value.notes.push(...record.notes);
    if (record.truncated) value.entries_truncated = true;
    for (const entry of record.entries) {
      const cost = entryLine(entry).length + 1;
      if (value.entries.length >= MAX_TREE_ENTRIES || cost > budget.remaining) {
        value.entries_truncated = true;
        break;
      }
      budget.remaining -= cost;
      value.entries.push(entry);
    }
    for (const file of record.files) {
      const fitted = fitToBudget(file, budget);
      if (fitted === null) {
        value.omitted.push(`${file.path}: output budget exhausted; read it in a separate call`);
        continue;
      }
      if (fitted.truncated) value.truncated = true;
      value.files.push(fitted);
    }
    value.omitted.push(...record.omitted);
  }

  if (value.entries_truncated) value.truncated = true;

  return value;
}

/** Render one directory or tree entry exactly as the model sees it. */
function entryLine(entry) {
  const size = entry.size === null ? '' : `  (${formatBytes(entry.size)})`;
  return `  ${String(entry.type).padEnd(9)} ${entry.path}${size}`;
}

/**
 * Render a `github_read` value as model-facing text.
 *
 * @param {object} value - the tool output value.
 * @returns {string}
 */
export function renderRead(value) {
  const header = `${value.repo} · ${value.ref}`;
  const parts = [];

  if (value.entries.length > 0) {
    const label = value.recursive ? 'recursive tree' : 'directory';
    parts.push(`${header} · ${value.target} · ${label}, ${value.entries.length} entries`);
    for (const entry of value.entries) {
      parts.push(entryLine(entry));
    }
    if (value.entries_truncated) parts.push('(entry list truncated; narrow the path or drop recursive.)');
  }

  for (const file of value.files) {
    const meta = [`${file.total_lines} line${file.total_lines === 1 ? '' : 's'}`, formatBytes(file.bytes)];
    parts.push('');
    parts.push(`${header} · ${file.path}`);
    parts.push(meta.join(' · '));
    if (file.content) {
      const width = Math.max(3, String(file.end_line).length);
      const numbered = file.content
        .split('\n')
        .map((line, index) => `${String(file.start_line + index).padStart(width)} | ${line}`)
        .join('\n');
      parts.push('');
      parts.push(numbered);
    }
    if (file.note) parts.push(`(${file.note})`);
  }

  if (value.omitted.length > 0) {
    parts.push('');
    for (const entry of value.omitted) parts.push(`(not shown: ${entry})`);
  }
  if (value.notes.length > 0) {
    parts.push('');
    for (const note of value.notes) parts.push(`(note: ${note})`);
  }
  if (parts.length === 0) parts.push(`${header} · ${value.target} · no content`);
  return parts.join('\n');
}
