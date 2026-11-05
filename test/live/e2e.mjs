/**
 * Live end-to-end exercise of every dsh-github-cli tool against GitHub.
 *
 * The script imports the plugin exactly as the Host does, captures the tool
 * definitions from `apply()`, and calls their `execute` functions with a real
 * `gh` login. It needs network access and a shell that can spawn gh/git with
 * piped stdio (run it with danger-full-access, not inside a confined sandbox).
 *
 * The target repository is Unchpokable/clanker-playground; a scratch repository
 * is created for lifecycle tests and deleted at the end. The script records a
 * JSON report next to itself.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../../index.js';
import { resolveConfig } from '../../lib/config.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(SCRIPT_DIR, '..', '..');
const RUN = Date.now().toString(36);
const TARGET = 'Unchpokable/clanker-playground';
const OWNER = 'Unchpokable';
const REPO_NAME = TARGET.split('/')[1];
const WORK_ROOT = join(WORKSPACE, '.dsh', `e2e-${RUN}`);
const REPORT_PATH = join(WORKSPACE, 'test', 'live', `report-${RUN}.json`);
const LATEST_PATH = join(WORKSPACE, 'test', 'live', 'report-latest.json');

const SCRATCH = `clanker-plugin-e2e-${RUN}`;
const EXTRACT_REPO = `clanker-extract-${RUN}`;
const TAG = `v0.0.1-e2e-${RUN}`;
const BRANCH = `e2e/work-${RUN}`;
const CLOSE_BRANCH = `e2e/close-${RUN}`;
const LINK_BRANCH = `dsh/link-link-me`;
const LABEL = `plugin-e2e-${RUN}`;
const SECRET = 'PLUGIN_E2E_SECRET';
const VARIABLE = 'PLUGIN_E2E_VARIABLE';

const PR_FILE = 'docs/plugin-e2e.md';
const PR_COPY = 'docs/plugin-e2e-copy.md';
const PR_MOVED = 'docs/plugin-e2e-moved.md';
const PR_DELETE = 'docs/plugin-e2e-delete.md';
const PR_COMMIT_A = 'docs/plugin-e2e-commit-a.md';
const PR_COMMIT_B = 'docs/plugin-e2e-commit-b.md';
const MAIN_ADVANCE = 'docs/plugin-e2e-main-advance.md';
const CLOSE_FILE = 'docs/plugin-e2e-close.md';
const WORKFLOW_FILE = '.github/workflows/plugin-e2e.yml';
const EXTRACT_A = 'extract-me/a.txt';
const EXTRACT_B = 'extract-me/b.txt';
const LINK_FILE = 'link-me/c.txt';
const ASSET_FILE = 'plugin-e2e-asset.txt';

// Git authentication for clone/push inside extraction. A private global config
// disables the system credential manager (which may prompt) and uses the
// signed-in gh account through git's credential protocol.
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GH_PROMPT_DISABLED = '1';

const startedAt = new Date();
const checks = [];
const approvals = [];
const notes = [];
const evidence = {};
let failures = 0;
let skips = 0;
let fatal = null;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function makeSubprocess() {
  return {
    async resolveExecutable(name) {
      return name;
    },
    spawn({ argv, cwd, env, signal, stdio }) {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...(env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const outChunks = [];
      const errChunks = [];
      let outBytes = 0;
      let errBytes = 0;
      const maxOut = stdio?.stdout?.maxBytes ?? 48 * 1024 * 1024;
      const maxErr = stdio?.stderr?.maxBytes ?? 1024 * 1024;
      const done = new Promise((resolveDone, rejectDone) => {
        child.stdout.on('data', (chunk) => {
          outBytes += chunk.length;
          if (outBytes <= maxOut) outChunks.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
          errBytes += chunk.length;
          if (errBytes <= maxErr) errChunks.push(chunk);
        });
        child.on('error', rejectDone);
        child.on('close', (code, closeSignal) => resolveDone({ exitCode: code, signal: closeSignal }));
      });
      const onAbort = () => {
        try { child.kill(); } catch { /* already gone */ }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: Buffer.concat(outChunks).toString('utf8'), lossy: outBytes > maxOut }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(errChunks).toString('utf8'), lossy: errBytes > maxErr }) },
        },
        terminate() {
          signal?.removeEventListener('abort', onAbort);
          try { child.kill(); } catch { /* already gone */ }
        },
      };
    },
  };
}

function createRuntime(overrides = {}) {
  const tools = new Map();
  const approval = {
    mode: 'allowed-once',
    requests: [],
    async request(request) {
      this.requests.push({
        toolName: request.toolName,
        callId: request.callId,
        reason: String(request.reason ?? '').split('\n').slice(0, 6).join('\n'),
        at: new Date().toISOString(),
      });
      if (this.mode === 'rejected') return 'rejected';
      if (this.mode === 'cancelled') return 'cancelled';
      return 'allowed-once';
    },
  };
  const services = new Map([
    ['approval', approval],
    ['subprocess', makeSubprocess()],
    ['sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) }],
  ]);
  const ctx = {
    tools: { register(spec) { tools.set(spec.name, spec); } },
    get(name) { return services.get(name); },
    effect() {},
  };
  const config = resolveConfig({
    defaultRepo: TARGET,
    defaultOwner: OWNER,
    requireApproval: true,
    allowDestructive: true,
    allowAdmin: true,
    allowGenericApi: 'write',
    workspaceRoot: WORK_ROOT,
    scratchDir: '.dsh/github',
    maxOutputChars: 80_000,
    timeoutMs: 60_000,
    longTimeoutMs: 300_000,
    ...overrides,
  });
  apply(ctx, config);
  return { config, tools, approval };
}

const runtime = createRuntime();
const agent = { id: 'live-e2e-agent', session: {} };
let callSeq = 0;

const READ_CALLS = {
  github_status: () => true,
  github_read: () => true,
  github_diff: () => true,
  github_search: () => true,
  github_pr: (args) => args.action === undefined || args.action === 'view' || args.action === 'list',
  github_issue: (args) => args.action === 'view' || args.action === 'list',
  github_repo: (args) => ['view', 'list', 'access_list'].includes(args.action),
  github_ref: (args) => args.action === 'list' || args.action === 'view',
  github_actions: (args) => ['workflows', 'workflow', 'runs', 'run', 'logs', 'artifacts', 'secrets_list', 'variables_list', 'caches_list', 'permissions_get', 'runners_list'].includes(args.action),
  github_release: (args) => args.action === 'list' || args.action === 'view',
  github_api: (args) => args.graphql !== undefined || !args.method || String(args.method).toUpperCase() === 'GET' || String(args.method).toUpperCase() === 'HEAD',
  github_extract: (args) => args.action === 'plan' || args.action === 'status',
  github_workspace: (args) => args.action === 'status' || args.action === 'list',
};

function isTransientError(error) {
  const message = `${error?.message ?? ''} ${error?.details ?? ''}`;
  return /HTTP 50[234]|Service Unavailable|Bad Gateway|Gateway Timeout|socket hang up|ECONNRESET|ETIMEDOUT|rate limit|abuse detection/i.test(message);
}

async function callTool(name, args = {}, active = runtime) {
  const tool = active.tools.get(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  const readCall = READ_CALLS[name]?.(args) === true;
  const attempts = readCall ? 4 : 1;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const exec = { agent, callId: `e2e-${++callSeq}`, signal: undefined, toolName: name };
      const value = await tool.execute(args, exec);
      if (typeof tool.output?.render === 'function') {
        const rendered = tool.output.render(args, value);
        const text = Array.isArray(rendered)
          ? rendered.map((part) => part?.text ?? '').join('\n')
          : String(rendered ?? '');
        if (!text.trim()) throw new Error(`${name} render returned no text`);
      }
      return value;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || !isTransientError(error)) throw error;
      const delay = [2_000, 5_000, 10_000][attempt] ?? 10_000;
      console.log(`RETRY ${name} after ${delay}ms: ${error.message.slice(0, 100)}`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function describeValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.slice(0, 140);
  if (value.summary) return String(value.summary).slice(0, 160);
  if (value.data?.kind) return value.data.kind;
  return JSON.stringify(value).slice(0, 140);
}

async function step(name, fn, options = {}) {
  const started = Date.now();
  try {
    const value = await fn();
    const detail = typeof options.detail === 'function' ? options.detail(value) : (options.detail ?? describeValue(value));
    checks.push({ name, status: 'pass', ms: Date.now() - started, detail });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    return value;
  } catch (error) {
    const message = error?.message ?? String(error);
    const status = options.optional ? 'warn' : 'fail';
    checks.push({
      name,
      status,
      ms: Date.now() - started,
      error: message,
      code: error?.code ?? null,
      details: error?.details ? String(error.details).slice(0, 500) : null,
    });
    if (options.optional) {
      console.log(`WARN ${name} — ${message}`);
    } else {
      failures += 1;
      console.log(`FAIL ${name} — ${message}`);
    }
    if (options.throwOnFail) {
      error.liveStep = name;
      throw error;
    }
    return undefined;
  }
}

function skip(name, reason) {
  skips += 1;
  checks.push({ name, status: 'skip', reason });
  console.log(`SKIP ${name} — ${reason}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectError(name, fn, pattern, options = {}) {
  return step(name, async () => {
    try {
      await fn();
    } catch (error) {
      const message = error?.message ?? String(error);
      assert(pattern.test(message), `unexpected error: ${message}`);
      return message.slice(0, 160);
    }
    throw new Error('operation unexpectedly succeeded');
  }, options);
}

async function waitFor(label, probe, timeoutMs = 120_000, intervalMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not happen within ${Math.round(timeoutMs / 1000)}s`);
}

async function renameRepository(fromName, toName) {
  const deadline = Date.now() + 120_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await callTool('github_repo', {
        action: 'rename', repo: fromName, new_name: toName.split('/')[1],
        apply: true, confirm: `${fromName} -> ${toName}`,
      });
    } catch (error) {
      lastError = error;
      if (!/conflicting repository operation/i.test(error.message)) throw error;
      await sleep(5_000);
    }
  }
  throw lastError ?? new Error('rename did not complete');
}

function ghDirect(args, input) {
  return execFileSync('gh', args, {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
    timeout: 120_000,
  });
}

function deleteRepoDirect(fullName) {
  try {
    ghDirect(['api', '--method', 'DELETE', `repos/${fullName}`]);
    return true;
  } catch {
    return false;
  }
}

function archiveRepoDirect(fullName) {
  try {
    ghDirect(['api', '--method', 'PATCH', `repos/${fullName}`, '-F', 'archived=true']);
    return true;
  } catch {
    return false;
  }
}

function deleteReleaseDirect(tag) {
  try {
    const releases = JSON.parse(ghDirect(['api', `repos/${TARGET}/releases`]));
    const found = releases.find((release) => release.tag_name === tag);
    if (!found) return false;
    ghDirect(['api', '--method', 'DELETE', `repos/${TARGET}/releases/${found.id}`]);
    return true;
  } catch {
    return false;
  }
}

function deleteTagDirect(tag) {
  try {
    ghDirect(['api', '--method', 'DELETE', `repos/${TARGET}/git/refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

function deleteLabelDirect(name) {
  try {
    ghDirect(['api', '--method', 'DELETE', `repos/${TARGET}/labels/${name}`]);
    return true;
  } catch {
    return false;
  }
}

function deleteMilestoneDirect(title) {
  try {
    const milestones = JSON.parse(ghDirect(['api', `repos/${TARGET}/milestones?state=all`]));
    const found = milestones.find((milestone) => milestone.title === title);
    if (!found) return false;
    ghDirect(['api', '--method', 'DELETE', `repos/${TARGET}/milestones/${found.number}`]);
    return true;
  } catch {
    return false;
  }
}

const WORKFLOW = [
  'name: plugin-e2e',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      marker:',
  '        description: Marker echoed by the job',
  '        required: false',
  '        default: default-marker',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  probe:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Echo marker',
  '        run: echo "marker=${{ inputs.marker }}"',
  '      - name: Create artifact',
  '        run: mkdir -p out && echo "hello from plugin e2e" > out/hello.txt',
  '      - name: Upload artifact',
  '        uses: actions/upload-artifact@v4',
  '        with:',
  '          name: plugin-e2e-artifact',
  '          path: out/hello.txt',
  '      - name: Cache probe',
  '        uses: actions/cache@v4',
  '        with:',
  '          path: out',
  '          key: plugin-e2e-${{ github.run_id }}',
  '',
].join('\n');

let scratchName = null;
let scratchActualName = null;
let issueNumber = null;
let prNumber = null;
let closePrNumber = null;
let runId = null;
let releaseId = null;
let extractConfirmed = false;
let linkPrNumber = null;
let issuesEnabled = false;

async function runAll() {
  await mkdir(WORK_ROOT, { recursive: true });
  process.chdir(WORK_ROOT);
  const gitConfigPath = join(WORK_ROOT, 'gitconfig');
  await writeFile(
    gitConfigPath,
    '[credential]\n\thelper =\n[credential "https://github.com"]\n\thelper = !gh auth git-credential\n',
    'utf8',
  );
  process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  // ------------------------------------------------------------------------
  // Status and registration
  // ------------------------------------------------------------------------
  await step('tool registration', async () => {
    const expected = [
      'github_status', 'github_read', 'github_pr', 'github_diff', 'github_review',
      'github_pr_create', 'github_issue_create', 'github_repo', 'github_file',
      'github_workspace', 'github_ref', 'github_issue', 'github_actions',
      'github_org', 'github_api', 'github_extract', 'github_release', 'github_search',
    ];
    const missing = expected.filter((name) => !runtime.tools.has(name));
    assert(missing.length === 0, `missing tools: ${missing.join(', ')}`);
    return `${runtime.tools.size} tools`;
  }, { detail: (value) => value });

  const status = await step('github_status', () => callTool('github_status'), { throwOnFail: true });
  evidence.account = status.account;
  evidence.rateLimit = status.rate_limit;
  await step('status reports authentication and capabilities', async () => {
    assert(status.authenticated === true, 'gh is not authenticated');
    assert(status.account === OWNER, `unexpected account ${status.account}`);
    assert(status.capabilities?.gh?.found === true, 'gh capability missing');
    assert(Array.isArray(status.bindings), 'bindings missing');
    return `${status.account}, gh ${status.version}`;
  }, { detail: (value) => value });

  // ------------------------------------------------------------------------
  // Repository lifecycle on a scratch repository
  // ------------------------------------------------------------------------
  const scratch = await step('github_repo create (scratch, auto_init, topics)', () => callTool('github_repo', {
    action: 'create',
    owner: OWNER,
    name: SCRATCH,
    visibility: 'public',
    description: 'Temporary repository for dsh-github-cli live tests',
    auto_init: true,
    has_issues: true,
    topics: ['dsh-plugin', 'e2e'],
  }), { throwOnFail: true });
  scratchName = scratch.repo;
  scratchActualName = scratch.repo;
  evidence.scratchRepo = scratch.url;

  await step('github_repo view (scratch)', async () => {
    const view = await callTool('github_repo', { action: 'view', repo: scratchName });
    assert(view.data.repo.full_name === scratchName, 'wrong repository');
    assert(view.data.repo.default_branch === 'main', `default branch ${view.data.repo.default_branch}`);
    return view.summary;
  });

  await step('github_repo list (owner)', async () => {
    const list = await callTool('github_repo', { action: 'list', owner: OWNER, limit: 100 });
    assert(Array.isArray(list.data.items), 'items is not an array');
    assert(list.data.items.some((item) => item.full_name === scratchName), 'scratch repository not listed');
    return `${list.data.items.length} repositories`;
  });

  await step('github_repo edit metadata and topics', async () => {
    const edited = await callTool('github_repo', {
      action: 'edit',
      repo: scratchName,
      description: 'Edited by dsh-github-cli e2e',
      homepage: 'https://example.com/dsh-github-cli',
      has_wiki: false,
      topics: ['dsh-plugin', 'e2e', 'edited'],
    });
    assert(edited.data.repo.description === 'Edited by dsh-github-cli e2e', 'description not updated');
    assert(edited.data.repo.topics.includes('edited'), 'edited topics not returned');
    const view = await callTool('github_repo', { action: 'view', repo: scratchName });
    assert(view.data.repo.topics.includes('edited'), 'topics not persisted');
    return edited.summary;
  });

  await step('github_repo topics', async () => {
    const topics = await callTool('github_repo', { action: 'topics', repo: scratchName, topics: ['dsh-plugin', 'e2e'] });
    assert(topics.data.topics.length === 2, 'unexpected topic count');
    return topics.summary;
  });

  await step('github_repo access_list', async () => {
    const access = await callTool('github_repo', { action: 'access_list', repo: scratchName });
    assert(Array.isArray(access.data.items), 'access items missing');
    return `${access.data.items.length} collaborators`;
  });

  await step('github_repo access_add self (expected API limitation)', () => callTool('github_repo', {
    action: 'access_add', repo: scratchName, user: OWNER, permission: 'push',
  }), { optional: true });

  await step('github_repo archive', async () => {
    const archived = await callTool('github_repo', { action: 'archive', repo: scratchName });
    assert(archived.data.repo.archived === true, 'repository is not archived');
    return archived.summary;
  });

  await step('github_repo unarchive', async () => {
    const unarchived = await callTool('github_repo', { action: 'unarchive', repo: scratchName });
    assert(unarchived.data.repo.archived === false, 'repository is still archived');
    return unarchived.summary;
  });

  const scratchOriginal = scratchName;
  const renamedName = `${OWNER}/${SCRATCH}-renamed`;
  await step('github_repo rename', async () => {
    const renamed = await renameRepository(scratchName, renamedName);
    assert(renamed.repo === renamedName, `unexpected renamed repo ${renamed.repo}`);
    scratchName = renamedName;
    scratchActualName = renamedName;
    return renamed.summary;
  });

  await step('github_repo rename back', async () => {
    const renamed = await renameRepository(scratchName, scratchOriginal);
    assert(renamed.repo === scratchOriginal, 'rename back failed');
    scratchName = scratchOriginal;
    scratchActualName = scratchOriginal;
    return renamed.summary;
  });

  // ------------------------------------------------------------------------
  // Target repository reads and issue enablement
  // ------------------------------------------------------------------------
  await step('github_read root listing', async () => {
    const listing = await callTool('github_read', { repo: TARGET });
    assert(Array.isArray(listing.entries), 'entries missing');
    assert(listing.entries.some((entry) => entry.path === 'PLUGIN_TEST.md'), 'PLUGIN_TEST.md not listed');
    return `${listing.entries.length} entries`;
  });

  await step('github_read file with line range', async () => {
    const read = await callTool('github_read', { repo: TARGET, path: 'PLUGIN_TEST.md', start_line: 1, end_line: 4 });
    const file = read.files?.[0];
    assert(file && file.start_line === 1 && file.end_line === 4, 'unexpected line range');
    assert(file.content.split('\n').length === 4, 'unexpected returned content');
    return `${file.content.split('\n').length} lines of ${file.total_lines}`;
  });

  await step('github_read multiple paths', async () => {
    const read = await callTool('github_read', { repo: TARGET, paths: ['PLUGIN_TEST.md', 'cloudysky.json'] });
    assert(read.files?.length === 2, 'expected two files');
    return `${read.files.length} files`;
  });

  await step('github_read recursive tree', async () => {
    const tree = await callTool('github_read', { repo: TARGET, recursive: true });
    assert(Array.isArray(tree.entries), 'tree entries missing');
    return `${tree.entries.length} entries`;
  });

  await step('github_file read', async () => {
    const read = await callTool('github_file', { action: 'read', repo: TARGET, path: 'vms.c', start_line: 1, end_line: 3 });
    const file = read.files?.[0];
    assert(file && file.end_line - file.start_line + 1 === 3, 'unexpected file read');
    return `${file.content.split('\n').length} lines`;
  });

  await step('github_file stat file', async () => {
    const stat = await callTool('github_file', { action: 'stat', repo: TARGET, path: 'vms.c' });
    assert(stat.data.kind === 'file-stat', `unexpected kind ${stat.data.kind}`);
    assert(stat.data.size > 0, 'file size missing');
    return `${stat.data.size} bytes`;
  });

  await step('github_repo edit enable issues on target', async () => {
    const edited = await callTool('github_repo', { action: 'edit', repo: TARGET, has_issues: true });
    issuesEnabled = true;
    return edited.summary;
  });

  // ------------------------------------------------------------------------
  // Branch, files, PR, review, merge on the target repository
  // ------------------------------------------------------------------------
  await step('github_ref create branch', async () => {
    const created = await callTool('github_ref', { action: 'create', repo: TARGET, ref: BRANCH, from: 'main' });
    assert(created.data.kind === 'branch', 'branch not created');
    return created.data.name;
  });

  await step('github_ref view branch', async () => {
    const view = await callTool('github_ref', { action: 'view', repo: TARGET, ref: BRANCH });
    assert(view.data.name === BRANCH, 'wrong branch');
    return view.data.sha;
  });

  await step('github_ref list branches', async () => {
    const list = await callTool('github_ref', { action: 'list', repo: TARGET, kind: 'branch' });
    assert(list.data.items.some((item) => item.name === BRANCH), 'new branch missing');
    return `${list.data.items.length} branches`;
  });

  await step('github_file write on branch', async () => {
    const written = await callTool('github_file', {
      action: 'write', repo: TARGET, branch: BRANCH, path: PR_FILE,
      content: '# Plugin E2E\n\nLine two.\nLine three.\n',
      message: 'e2e: add PR fixture',
    });
    assert(written.data.kind === 'file-write', 'write result missing');
    return written.data.sha;
  });

  await step('github_file copy', async () => {
    const copied = await callTool('github_file', {
      action: 'copy', repo: TARGET, branch: BRANCH, from: PR_FILE, to: PR_COPY,
      message: 'e2e: copy fixture',
    });
    assert(copied.data.kind === 'file-commit', 'copy result missing');
    return copied.summary;
  });

  await step('github_file move', async () => {
    const moved = await callTool('github_file', {
      action: 'move', repo: TARGET, branch: BRANCH, from: PR_COPY, to: PR_MOVED,
      message: 'e2e: move fixture',
    });
    assert(moved.data.kind === 'file-commit', 'move result missing');
    return moved.summary;
  });

  await step('github_file write then delete', async () => {
    await callTool('github_file', {
      action: 'write', repo: TARGET, branch: BRANCH, path: PR_DELETE,
      content: 'Temporary file.\n', message: 'e2e: add temporary file',
    });
    const deleted = await callTool('github_file', {
      action: 'delete', repo: TARGET, branch: BRANCH, path: PR_DELETE,
      message: 'e2e: delete temporary file',
    });
    assert(deleted.data.kind === 'file-delete', 'delete result missing');
    return deleted.summary;
  });

  await step('github_file atomic commit', async () => {
    const committed = await callTool('github_file', {
      action: 'commit', repo: TARGET, branch: BRANCH, message: 'e2e: atomic multi-file commit',
      changes: [
        { op: 'write', path: PR_COMMIT_A, content: 'A\n' },
        { op: 'write', path: PR_COMMIT_B, content: 'B\n' },
      ],
    });
    assert(committed.data.changes.length === 2, 'unexpected change count');
    return committed.data.commit;
  });

  await step('github_file stat directory', async () => {
    const stat = await callTool('github_file', { action: 'stat', repo: TARGET, ref: BRANCH, path: 'docs' });
    assert(stat.data.kind === 'directory', `unexpected kind ${stat.data.kind}`);
    return `${stat.data.entries.length} entries`;
  });

  await expectError(
    'github_file write to protected branch without override',
    () => callTool('github_file', {
      action: 'write', repo: TARGET, branch: 'main', path: 'docs/plugin-e2e-forbidden.md',
      content: 'should not exist\n', message: 'e2e: forbidden write',
    }),
    /Direct writes to protected branch/i,
  );

  await expectError(
    'github_file overwrite without sha is rejected',
    () => callTool('github_file', {
      action: 'write', repo: TARGET, path: 'PLUGIN_TEST.md',
      content: 'should not overwrite\n', message: 'e2e: unsafe overwrite',
    }),
    /already exists.*sha/i,
  );

  await step('github_pr_create (draft)', async () => {
    const created = await callTool('github_pr_create', {
      repo: TARGET, title: `[plugin e2e] ${RUN}`, head: BRANCH, base: 'main',
      body: 'Live end-to-end test of dsh-github-cli.', draft: true,
    });
    prNumber = created.number;
    evidence.pr = created.url;
    assert(created.created === true, 'PR not reported as created');
    assert(created.draft === true, 'PR is not a draft');
    return `#${created.number}`;
  }, { throwOnFail: true });

  await step('github_pr view with all sections', async () => {
    const view = await callTool('github_pr', {
      repo: TARGET, pr: String(prNumber),
      include: ['description', 'files', 'comments', 'commits', 'checks'],
    });
    assert(view.number === prNumber, 'wrong PR');
    assert(view.files.items.some((file) => file.path === PR_FILE), 'fixture file not in PR');
    return `${view.files.items.length} files, ${view.commits.items.length} commits`;
  });

  await step('github_pr list', async () => {
    const list = await callTool('github_pr', { repo: TARGET, action: 'list', state: 'open', limit: 50 });
    assert(list.data.items.some((item) => item.number === prNumber), 'PR not listed');
    return `${list.data.items.length} open PRs`;
  });

  await step('github_diff PR paging and path filter', async () => {
    const first = await callTool('github_diff', { repo: TARGET, pr: prNumber, paths: ['docs/*.md'], max_chars: 120 });
    assert(first.next_offset !== null, 'diff did not page');
    const second = await callTool('github_diff', { repo: TARGET, pr: prNumber, paths: ['docs/*.md'], offset: first.next_offset, max_chars: 4000 });
    assert(second.offset === first.next_offset, 'offset not honored');
    assert(second.total_files >= 1, 'no files in diff');
    return `${second.total_files} files, ${second.total_chars} chars`;
  });

  await step('github_diff compare branches', async () => {
    const diff = await callTool('github_diff', { repo: TARGET, base: 'main', head: BRANCH, paths: [PR_FILE] });
    assert(diff.kind === 'compare', 'not a comparison diff');
    assert(diff.files.some((file) => file.path === PR_FILE), 'fixture not in comparison');
    return `${diff.files.length} file(s)`;
  });

  await step('github_read at PR head', async () => {
    const read = await callTool('github_read', { repo: TARGET, pr: prNumber, path: PR_FILE });
    const file = read.files?.[0];
    assert(file && file.total_lines === 4, 'PR head read failed');
    return `${file.total_lines} lines`;
  });

  await step('github_pr update title/body', async () => {
    const updated = await callTool('github_pr', {
      repo: TARGET, action: 'update', pr: String(prNumber),
      title: `[plugin e2e] ${RUN} updated`, body: 'Updated body from the live test.',
    });
    assert(updated.data.pull.title.endsWith('updated'), 'title not updated');
    return updated.data.pull.title;
  });

  await step('github_pr comment', async () => {
    const comment = await callTool('github_pr', {
      repo: TARGET, action: 'comment', pr: String(prNumber), body: `E2E comment ${RUN}`,
    });
    assert(comment.data.id !== null, 'comment id missing');
    return comment.data.url;
  });

  await step('github_pr label add', async () => {
    const labeled = await callTool('github_pr', {
      repo: TARGET, action: 'label', pr: String(prNumber), add: ['bug'],
    });
    assert(labeled.data.added.includes('bug'), 'label not added');
    return labeled.summary;
  });

  await step('github_pr label set and remove', async () => {
    await callTool('github_pr', { repo: TARGET, action: 'label', pr: String(prNumber), set: ['documentation'] });
    const removed = await callTool('github_pr', {
      repo: TARGET, action: 'label', pr: String(prNumber), remove: ['documentation'],
    });
    assert(removed.data.removed.includes('documentation'), 'label not removed');
    return removed.summary;
  });

  await step('github_pr reviewers self-request (expected limitation)', () => callTool('github_pr', {
    repo: TARGET, action: 'reviewers', pr: String(prNumber), add_users: [OWNER],
  }), { optional: true });

  await step('github_pr ready', async () => {
    const ready = await callTool('github_pr', { repo: TARGET, action: 'ready', pr: String(prNumber) });
    assert(ready.data.draft === false, 'PR still draft');
    return ready.summary;
  });

  await step('github_pr draft', async () => {
    const draft = await callTool('github_pr', { repo: TARGET, action: 'draft', pr: String(prNumber) });
    assert(draft.data.draft === true, 'PR not draft');
    return draft.summary;
  });

  await step('github_pr ready again', async () => {
    const ready = await callTool('github_pr', { repo: TARGET, action: 'ready', pr: String(prNumber) });
    assert(ready.data.draft === false, 'PR still draft');
    return ready.summary;
  });

  await step('advance main for update_branch', async () => {
    const write = await callTool('github_file', {
      action: 'write', repo: TARGET, branch: 'main', path: MAIN_ADVANCE,
      content: `Main advanced at ${new Date().toISOString()}\n`,
      message: 'e2e: advance main for update-branch test', allow_protected: true,
    });
    return write.data.commit;
  });

  await step('github_pr update_branch', async () => {
    const before = await callTool('github_pr', { repo: TARGET, pr: String(prNumber) });
    const updated = await callTool('github_pr', {
      repo: TARGET, action: 'update_branch', pr: String(prNumber),
    });
    await waitFor('pull request branch merge', async () => {
      const view = await callTool('github_pr', { repo: TARGET, pr: String(prNumber) });
      return view.mergeable !== false && view.head_sha !== before.head_sha ? view : null;
    }, 90_000, 3_000);
    return updated.summary;
  });

  await step('github_review dry run', async () => {
    const preview = await callTool('github_review', {
      repo: TARGET, pr: String(prNumber), event: 'COMMENT', body: 'Dry-run body.',
      comments: [{ path: PR_FILE, line: 2, start_line: 1, body: 'Dry-run inline range.' }],
      dry_run: true,
    });
    assert(preview.dry_run === true && preview.posted === false, 'dry run posted something');
    assert(preview.inline_comments === 1, 'inline comment missing from preview');
    return `${preview.event} on ${preview.commit}`;
  });

  await step('github_review post with inline range', async () => {
    const review = await callTool('github_review', {
      repo: TARGET, pr: String(prNumber), event: 'COMMENT',
      body: `E2E review ${RUN}`,
      comments: [{ path: PR_FILE, line: 2, start_line: 1, body: `E2E inline range ${RUN}` }],
    });
    assert(review.posted === true, 'review not posted');
    assert(review.inline_comments === 1, 'inline comment count wrong');
    evidence.review = review.url;
    return `review ${review.review_id}`;
  });

  await step('github_pr view sees review and comment', async () => {
    const view = await callTool('github_pr', {
      repo: TARGET, pr: String(prNumber), include: ['comments'],
    });
    assert(view.comments.items.some((item) => item.kind === 'review'), 'review missing');
    assert(view.comments.items.some((item) => item.kind === 'comment'), 'comment missing');
    return `${view.comments.items.length} comment items`;
  });

  await step('github_pr merge (squash, delete branch)', async () => {
    // GitHub can leave `mergeable` at null/UNKNOWN for minutes after an
    // update-branch call even though the merge endpoint accepts the pull
    // request. Only an explicit false is treated as a blocker.
    const mergeable = await waitFor('PR mergeable state', async () => {
      const view = await callTool('github_pr', { repo: TARGET, pr: String(prNumber) });
      return view.mergeable !== false ? view : null;
    }, 60_000, 5_000);
    assert(mergeable.state === 'OPEN', 'PR is not open before merge');
    const merged = await callTool('github_pr', {
      repo: TARGET, action: 'merge', pr: String(prNumber), method: 'squash',
      commit_title: `e2e squash ${RUN}`, delete_branch: true,
      apply: true, confirm: `${TARGET}#${prNumber}`,
    });
    assert(merged.data.merged === true, 'merge not confirmed');
    assert(merged.data.branch_deleted === true, 'branch not deleted');
    return merged.summary;
  });

  await step('github_pr view after merge', async () => {
    const view = await callTool('github_pr', { repo: TARGET, pr: String(prNumber) });
    assert(view.merged === true, 'PR not merged');
    assert(view.state === 'MERGED' || view.state === 'CLOSED', `unexpected state ${view.state}`);
    return `${view.state}, merged=${view.merged}`;
  });

  await step('github_ref create close/reopen branch', async () => {
    const created = await callTool('github_ref', { action: 'create', repo: TARGET, ref: CLOSE_BRANCH, from: 'main' });
    assert(created.data.kind === 'branch', 'branch not created');
    return created.data.name;
  });

  await step('github_file write close/reopen fixture', async () => {
    const written = await callTool('github_file', {
      action: 'write', repo: TARGET, branch: CLOSE_BRANCH, path: CLOSE_FILE,
      content: 'Close/reopen fixture.\n', message: 'e2e: close/reopen fixture',
    });
    return written.data.sha;
  });

  await step('github_pr_create close/reopen', async () => {
    const created = await callTool('github_pr_create', {
      repo: TARGET, title: `[plugin e2e] close/reopen ${RUN}`, head: CLOSE_BRANCH, base: 'main',
      body: 'Close and reopen this PR.',
    });
    closePrNumber = created.number;
    return `#${created.number}`;
  });

  await step('github_pr close', async () => {
    const closed = await callTool('github_pr', { repo: TARGET, action: 'close', pr: String(closePrNumber) });
    assert(closed.data.pull.state === 'CLOSED', 'PR not closed');
    return closed.summary;
  });

  await step('github_pr reopen', async () => {
    const reopened = await callTool('github_pr', { repo: TARGET, action: 'reopen', pr: String(closePrNumber) });
    assert(reopened.data.pull.state === 'OPEN', 'PR not reopened');
    return reopened.summary;
  });

  await step('github_pr close again', async () => {
    const closed = await callTool('github_pr', { repo: TARGET, action: 'close', pr: String(closePrNumber) });
    assert(closed.data.pull.state === 'CLOSED', 'PR not closed again');
    return closed.summary;
  });

  await step('github_ref delete close/reopen branch', async () => {
    const deleted = await callTool('github_ref', {
      action: 'delete', repo: TARGET, ref: CLOSE_BRANCH, apply: true,
      confirm: `${TARGET}:${CLOSE_BRANCH}`,
    });
    assert(deleted.data.kind === 'branch-delete', 'branch not deleted');
    return deleted.summary;
  });

  await expectError(
    'github_ref refuse deleting default branch',
    () => callTool('github_ref', {
      action: 'delete', repo: TARGET, ref: 'main', apply: true, confirm: `${TARGET}:main`,
    }),
    /Refusing to delete the default branch/i,
  );

  // ------------------------------------------------------------------------
  // Issues on the target repository
  // ------------------------------------------------------------------------
  await step('github_api create label', async () => {
    const created = await callTool('github_api', {
      action: 'request', path: `repos/${TARGET}/labels`, method: 'POST', allow_write: true,
      body: { name: LABEL, color: 'ededed', description: 'dsh-github-cli e2e' },
    });
    assert(created.data.response?.name === LABEL, 'label not created');
    return created.data.response.name;
  });

  await step('github_api create milestone', async () => {
    const created = await callTool('github_api', {
      action: 'request', path: `repos/${TARGET}/milestones`, method: 'POST', allow_write: true,
      body: { title: `Plugin E2E ${RUN}` },
    });
    assert(typeof created.data.response?.number === 'number', 'milestone number missing');
    return created.data.response.number;
  });

  const milestoneNumber = await step('read milestone number', async () => {
    const list = await callTool('github_api', {
      action: 'request', path: `repos/${TARGET}/milestones`, query: { state: 'open' },
    });
    const found = (list.data.response ?? []).find((item) => item.title === `Plugin E2E ${RUN}`);
    assert(found, 'milestone not found');
    return found.number;
  });

  await step('github_issue create', async () => {
    const created = await callTool('github_issue', {
      action: 'create', repo: TARGET, title: `[plugin e2e] issue ${RUN}`,
      body: 'Created by the live test.', labels: ['bug'], assignees: [OWNER],
      milestone: milestoneNumber,
    });
    issueNumber = created.data.issue.number;
    evidence.issue = created.url;
    assert(created.data.issue.assignees.includes(OWNER), 'issue not assigned');
    return `#${issueNumber}`;
  }, { throwOnFail: true });

  await step('github_issue_create compatibility alias', async () => {
    const created = await callTool('github_issue_create', {
      repo: TARGET, title: `[plugin e2e] alias issue ${RUN}`, body: 'Created through the alias.',
    });
    assert(typeof created.number === 'number', 'alias issue number missing');
    await callTool('github_issue', {
      action: 'close', repo: TARGET, issue: String(created.number), state_reason: 'not_planned',
    });
    return `#${created.number}`;
  });

  await step('github_issue view', async () => {
    const view = await callTool('github_issue', { action: 'view', repo: TARGET, issue: String(issueNumber) });
    assert(view.data.issue.number === issueNumber, 'wrong issue');
    assert(view.data.body.includes('live test'), 'body missing');
    return view.summary;
  });

  await step('github_issue list', async () => {
    let numbers = [];
    const list = await waitFor('issue list contains the new issue', async () => {
      const current = await callTool('github_issue', {
        repo: TARGET, action: 'list', state: 'all', limit: 50,
      });
      numbers = current.data.items.map((item) => item.number);
      return current.data.items.some((item) => item.number === issueNumber) ? current : null;
    }, 30_000, 2_000);
    if (!list) throw new Error(`issue #${issueNumber} not listed; saw [${numbers.join(', ')}]`);
    return `${list.data.items.length} issues`;
  });

  await step('github_issue update', async () => {
    const updated = await callTool('github_issue', {
      repo: TARGET, action: 'update', issue: String(issueNumber),
      title: `[plugin e2e] issue ${RUN} updated`, body: 'Updated by the live test.',
      labels: ['bug'], assignees: [OWNER],
    });
    assert(updated.data.issue.title.endsWith('updated'), 'title not updated');
    return updated.data.issue.title;
  });

  await step('github_issue comment', async () => {
    const comment = await callTool('github_issue', {
      repo: TARGET, action: 'comment', issue: String(issueNumber), body: `E2E issue comment ${RUN}`,
    });
    assert(comment.data.id !== null, 'comment id missing');
    return comment.data.url;
  });

  await step('github_issue label set/add/remove', async () => {
    await callTool('github_issue', {
      repo: TARGET, action: 'label', issue: String(issueNumber), set: [LABEL],
    });
    await callTool('github_issue', {
      repo: TARGET, action: 'label', issue: String(issueNumber), add: ['bug'],
    });
    const removed = await callTool('github_issue', {
      repo: TARGET, action: 'label', issue: String(issueNumber), remove: ['bug'],
    });
    assert(removed.data.removed.includes('bug'), 'label not removed');
    return removed.summary;
  });

  await step('github_issue assign remove/add', async () => {
    const removed = await callTool('github_issue', {
      repo: TARGET, action: 'assign', issue: String(issueNumber), remove: [OWNER],
    });
    assert(removed.data.removed.includes(OWNER), 'assignee not removed');
    const added = await callTool('github_issue', {
      repo: TARGET, action: 'assign', issue: String(issueNumber), add: [OWNER],
    });
    assert(added.data.added.includes(OWNER), 'assignee not added');
    return added.summary;
  });

  await step('github_issue milestone clear/set', async () => {
    await callTool('github_issue', {
      repo: TARGET, action: 'milestone', issue: String(issueNumber),
    });
    const set = await callTool('github_issue', {
      repo: TARGET, action: 'milestone', issue: String(issueNumber), milestone: milestoneNumber,
    });
    assert(set.data.issue.milestone === milestoneNumber, 'milestone not set');
    return `milestone ${milestoneNumber}`;
  });

  await step('github_issue lock', async () => {
    const locked = await callTool('github_issue', {
      repo: TARGET, action: 'lock', issue: String(issueNumber), reason: 'resolved',
    });
    assert(locked.data.locked === true, 'issue not locked');
    return locked.summary;
  });

  await step('github_issue unlock', async () => {
    const unlocked = await callTool('github_issue', {
      repo: TARGET, action: 'unlock', issue: String(issueNumber),
    });
    assert(unlocked.data.locked === false, 'issue not unlocked');
    return unlocked.summary;
  });

  await step('github_issue close', async () => {
    const closed = await callTool('github_issue', {
      repo: TARGET, action: 'close', issue: String(issueNumber), state_reason: 'completed',
    });
    assert(closed.data.issue.state === 'CLOSED', 'issue not closed');
    return closed.summary;
  });

  await step('github_issue reopen', async () => {
    const reopened = await callTool('github_issue', {
      repo: TARGET, action: 'reopen', issue: String(issueNumber),
    });
    assert(reopened.data.issue.state === 'OPEN', 'issue not reopened');
    return reopened.summary;
  });

  await step('github_issue transfer to scratch and back', async () => {
    const toScratch = await callTool('github_issue', {
      repo: TARGET, action: 'transfer', issue: String(issueNumber), new_repo: scratchName,
    });
    const movedNumber = toScratch.data.issue.number;
    assert(typeof movedNumber === 'number', 'transferred issue number missing');
    assert(toScratch.repo === scratchName, `unexpected transferred repository ${toScratch.repo}`);
    const back = await callTool('github_issue', {
      repo: scratchName, action: 'transfer', issue: String(movedNumber), new_repo: TARGET,
    });
    issueNumber = back.data.issue.number;
    assert(typeof issueNumber === 'number', 'returned issue number missing');
    return back.summary;
  });

  await step('github_issue close after transfer', async () => {
    const closed = await callTool('github_issue', {
      repo: TARGET, action: 'close', issue: String(issueNumber), state_reason: 'completed',
    });
    assert(closed.data.issue.state === 'CLOSED', 'issue not closed');
    return closed.summary;
  });

  // ------------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------------
  await step('github_file write workflow to main', async () => {
    const written = await callTool('github_file', {
      action: 'write', repo: TARGET, branch: 'main', path: WORKFLOW_FILE,
      content: WORKFLOW, message: 'e2e: add workflow fixture', allow_protected: true,
    });
    return written.data.commit;
  });

  await step('github_actions workflows', async () => {
    const workflows = await waitFor('workflow registration', async () => {
      const list = await callTool('github_actions', { action: 'workflows', repo: TARGET });
      return list.data.items.some((item) => item.path === WORKFLOW_FILE) ? list : null;
    }, 60_000, 3_000);
    return `${workflows.data.items.length} workflows`;
  });

  await step('github_actions workflow view', async () => {
    const workflow = await callTool('github_actions', {
      action: 'workflow', repo: TARGET, workflow: 'plugin-e2e.yml',
    });
    assert(workflow.data.workflow.path === WORKFLOW_FILE, 'wrong workflow');
    return workflow.data.workflow.name;
  });

  await step('github_actions permissions_get', async () => {
    const permissions = await callTool('github_actions', { action: 'permissions_get', repo: TARGET });
    assert(permissions.data.permissions?.enabled === true, 'Actions are not enabled');
    return `allowed_actions=${permissions.data.permissions.allowed_actions}`;
  });

  await step('github_actions runners_list', async () => {
    const runners = await callTool('github_actions', { action: 'runners_list', repo: TARGET });
    assert(Array.isArray(runners.data.items), 'runner items missing');
    return `${runners.data.items.length} repository runners`;
  });

  await step('github_actions secrets_set', async () => {
    process.env[SECRET] = `secret-${RUN}`;
    const set = await callTool('github_actions', {
      action: 'secrets_set', repo: TARGET, name: SECRET, from_env: SECRET,
      apply: true, confirm: `${TARGET}:${SECRET}`,
    });
    assert(set.data.kind === 'secret-set', 'secret not set');
    return set.summary;
  });

  await step('github_actions secrets_list', async () => {
    const list = await callTool('github_actions', { action: 'secrets_list', repo: TARGET });
    assert(list.data.items.some((item) => item.name === SECRET), 'secret missing from list');
    return `${list.data.items.length} secrets`;
  });

  await step('github_actions secrets_delete', async () => {
    const deleted = await callTool('github_actions', {
      action: 'secrets_delete', repo: TARGET, name: SECRET,
      apply: true, confirm: `${TARGET}:${SECRET}`,
    });
    assert(deleted.data.kind === 'secret-delete', 'secret not deleted');
    return deleted.summary;
  });

  await step('github_actions variables_set', async () => {
    const set = await callTool('github_actions', {
      action: 'variables_set', repo: TARGET, name: VARIABLE, value: `value-${RUN}`,
    });
    assert(set.data.kind === 'variable-set', 'variable not set');
    return set.summary;
  });

  await step('github_actions variables_list', async () => {
    const list = await callTool('github_actions', { action: 'variables_list', repo: TARGET });
    assert(list.data.items.some((item) => item.name === VARIABLE), 'variable missing from list');
    return `${list.data.items.length} variables`;
  });

  await step('github_actions variables_delete', async () => {
    const deleted = await callTool('github_actions', {
      action: 'variables_delete', repo: TARGET, name: VARIABLE,
    });
    assert(deleted.data.kind === 'variable-delete', 'variable not deleted');
    return deleted.summary;
  });

  await step('github_actions permissions_set', async () => {
    const set = await callTool('github_actions', {
      action: 'permissions_set', repo: TARGET, enabled: true, allowed_actions: 'all', apply: true,
    });
    assert(set.data.changed.enabled === true, 'permissions not changed');
    return set.summary;
  });

  const dispatchAt = Date.now();
  await step('github_actions dispatch', async () => {
    const dispatch = await callTool('github_actions', {
      action: 'dispatch', repo: TARGET, workflow: 'plugin-e2e.yml', ref: 'main',
      inputs: { marker: `marker-${RUN}` },
    });
    assert(dispatch.data.accepted === true, 'dispatch not accepted');
    return dispatch.summary;
  });

  const completedRun = await step('github_actions runs (wait for completion)', async () => {
    const run = await waitFor('workflow run completion', async () => {
      const runs = await callTool('github_actions', { action: 'runs', repo: TARGET, branch: 'main', limit: 50 });
      const candidates = runs.data.items
        .filter((item) => item.name === 'plugin-e2e')
        .filter((item) => Date.parse(item.created_at ?? '') >= dispatchAt - 60_000)
        .sort((left, right) => (right.id ?? 0) - (left.id ?? 0));
      const found = candidates[0];
      if (!found) return null;
      return found.status === 'completed' ? found : null;
    }, 360_000, 6_000);
    runId = run.id;
    assert(run.conclusion === 'success', `workflow concluded ${run.conclusion}`);
    evidence.workflowRun = run.html_url;
    return run;
  });

  await step('github_actions run view with jobs', async () => {
    const run = await callTool('github_actions', {
      action: 'run', repo: TARGET, run_id: runId, include_jobs: true,
    });
    assert(run.data.run.id === runId, 'wrong run');
    assert(Array.isArray(run.data.jobs) && run.data.jobs.length > 0, 'jobs missing');
    return `${run.data.jobs.length} jobs`;
  });

  await step('github_actions logs', async () => {
    const logs = await callTool('github_actions', {
      action: 'logs', repo: TARGET, run_id: runId, tail: 1000,
    });
    assert(logs.data.kind === 'run-logs', 'log kind missing');
    assert(logs.data.text.includes('marker='), 'marker not found in logs');
    return `${logs.data.text.split('\n').length} lines`;
  });

  await step('github_actions artifacts', async () => {
    const artifacts = await callTool('github_actions', {
      action: 'artifacts', repo: TARGET, run_id: runId,
    });
    assert(artifacts.data.items.some((item) => item.name === 'plugin-e2e-artifact'), 'artifact missing');
    return `${artifacts.data.items.length} artifacts`;
  });

  await step('github_actions download_artifact', async () => {
    const dir = join(WORK_ROOT, 'downloads', 'artifact');
    await mkdir(dir, { recursive: true });
    const download = await callTool('github_actions', {
      action: 'download_artifact', repo: TARGET, run_id: runId, dir: 'downloads/artifact',
    });
    const candidates = [join(dir, 'hello.txt'), join(dir, 'plugin-e2e-artifact', 'hello.txt')];
    const hello = candidates.find((candidate) => existsSync(candidate));
    assert(hello, `artifact file not found under ${dir}`);
    const content = await readFile(hello, 'utf8');
    assert(content.includes('hello from plugin e2e'), 'artifact content mismatch');
    return download.data.dir;
  });

  await step('github_actions caches_list and delete', async () => {
    await sleep(3_000);
    let caches = await callTool('github_actions', { action: 'caches_list', repo: TARGET });
    if (!caches.data.items.some((item) => item.key.startsWith(`plugin-e2e-${runId}`))) {
      await sleep(5_000);
      caches = await callTool('github_actions', { action: 'caches_list', repo: TARGET });
    }
    const cache = caches.data.items.find((item) => item.key.startsWith(`plugin-e2e-${runId}`));
    assert(cache, 'cache not saved by the workflow');
    const deleted = await callTool('github_actions', {
      action: 'caches_delete', repo: TARGET, key: cache.key,
    });
    assert(deleted.data.kind === 'cache-delete', 'cache not deleted');
    return cache.key;
  });

  await step('github_actions rerun', async () => {
    const rerun = await callTool('github_actions', { action: 'rerun', repo: TARGET, run_id: runId });
    assert(rerun.data.kind === 'run-action', 'rerun result missing');
    await sleep(4_000);
    return rerun.summary;
  });

  await step('github_actions cancel (after rerun)', async () => {
    const cancel = await callTool('github_actions', { action: 'cancel', repo: TARGET, run_id: runId });
    assert(cancel.data.kind === 'run-action', 'cancel result missing');
    return cancel.summary;
  }, { optional: true });

  await step('github_actions rerun_failed on a successful run (expected API rejection)', () => callTool('github_actions', {
    action: 'rerun_failed', repo: TARGET, run_id: runId,
  }), { optional: true });

  // ------------------------------------------------------------------------
  // Releases
  // ------------------------------------------------------------------------
  await step('github_ref create tag', async () => {
    const created = await callTool('github_ref', {
      action: 'create', repo: TARGET, ref: TAG, kind: 'tag', from: 'main',
    });
    assert(created.data.kind === 'tag', 'tag not created');
    return created.data.name;
  });

  await step('github_ref list tags', async () => {
    const list = await callTool('github_ref', { action: 'list', repo: TARGET, kind: 'tag' });
    assert(list.data.items.some((item) => item.name === TAG), 'tag not listed');
    return `${list.data.items.length} tags`;
  });

  const release = await step('github_release create', async () => {
    const created = await callTool('github_release', {
      action: 'create', repo: TARGET, tag: TAG, name: `Plugin E2E ${RUN}`,
      body: 'Release created by the live test.',
    });
    evidence.release = created.url;
    assert(created.data.release.tag_name === TAG, 'release tag mismatch');
    releaseId = created.data.release.id;
    return created.data.release;
  }, { throwOnFail: true });

  await step('github_release view by numeric id', async () => {
    const view = await callTool('github_release', { action: 'view', repo: TARGET, release: String(release.id) });
    assert(view.data.release.id === release.id, 'numeric release id returned another release');
    return `id ${release.id}`;
  });

  await step('github_release upload workspace file', async () => {
    await writeFile(join(WORK_ROOT, ASSET_FILE), `asset ${RUN}\n`, 'utf8');
    const uploaded = await callTool('github_release', {
      action: 'upload', repo: TARGET, tag: TAG, file: ASSET_FILE,
    });
    assert(uploaded.data.kind === 'release-upload', 'upload result missing');
    return uploaded.summary;
  });

  await step('github_release view by tag', async () => {
    const view = await callTool('github_release', { action: 'view', repo: TARGET, tag: TAG });
    assert(view.data.release.assets.some((asset) => asset.name === ASSET_FILE), 'asset missing');
    return `${view.data.release.assets.length} assets`;
  });

  await step('github_release list', async () => {
    const list = await callTool('github_release', { action: 'list', repo: TARGET });
    assert(list.data.items.some((item) => item.tag_name === TAG), 'release not listed');
    return `${list.data.items.length} releases`;
  });

  await step('github_release edit by tag', async () => {
    const edited = await callTool('github_release', {
      action: 'edit', repo: TARGET, tag: TAG, name: `Plugin E2E ${RUN} edited`,
      body: 'Edited by the live test.', prerelease: true,
    });
    assert(edited.data.release.prerelease === true, 'release not marked prerelease');
    return edited.summary;
  });

  await step('github_release download', async () => {
    const dir = join(WORK_ROOT, 'downloads', 'release');
    await mkdir(dir, { recursive: true });
    const download = await callTool('github_release', {
      action: 'download', repo: TARGET, tag: TAG, dir: 'downloads/release',
    });
    await access(join(dir, ASSET_FILE));
    return download.data.dir;
  });

  await step('github_release delete by tag', async () => {
    const deleted = await callTool('github_release', {
      action: 'delete', repo: TARGET, tag: TAG, apply: true,
      confirm: `${TARGET}:${TAG}`,
    });
    assert(deleted.data.kind === 'release-delete', 'release not deleted');
    return deleted.summary;
  });

  await step('github_api delete tag ref', async () => {
    const path = `repos/${TARGET}/git/refs/tags/${TAG}`;
    const deleted = await callTool('github_api', {
      action: 'request', path, method: 'DELETE', allow_write: true, apply: true, confirm: path,
    });
    assert(deleted.data.kind === 'api', 'delete tag returned no api result');
    return 'tag deleted';
  });

  // ------------------------------------------------------------------------
  // Extraction and submodule linking
  // ------------------------------------------------------------------------
  await step('github_file atomic commit extract fixtures', async () => {
    const committed = await callTool('github_file', {
      action: 'commit', repo: TARGET, branch: 'main', message: 'e2e: extract fixtures',
      allow_protected: true,
      changes: [
        { op: 'write', path: EXTRACT_A, content: 'alpha\n' },
        { op: 'write', path: EXTRACT_B, content: 'beta\n' },
      ],
    });
    return committed.data.commit;
  });

  const extractPlan = await step('github_extract plan (snapshot, create destination)', async () => {
    const plan = await callTool('github_extract', {
      action: 'plan',
      source: { repo: TARGET, path: 'extract-me' },
      destination: { owner: OWNER, name: EXTRACT_REPO, visibility: 'private' },
      history: 'snapshot',
    });
    assert(plan.plan?.confirm, 'plan confirm missing');
    assert(plan.plan.details?.strategy === 'snapshot', `unexpected strategy ${plan.plan.details?.strategy}`);
    return plan.plan;
  });

  await step('github_extract apply (snapshot, create destination)', async () => {
    const applied = await callTool('github_extract', {
      action: 'apply', apply: true, confirm: extractPlan.confirm,
      source: { repo: TARGET, path: 'extract-me' },
      destination: { owner: OWNER, name: EXTRACT_REPO, visibility: 'private' },
      history: 'snapshot',
    });
    extractConfirmed = true;
    assert(applied.data.kind === 'extract', 'extract result missing');
    assert(applied.data.history === 'snapshot', 'wrong history mode');
    evidence.extractRepo = applied.url;
    return applied.summary;
  });

  await step('verify extracted repository contents', async () => {
    const view = await callTool('github_repo', { action: 'view', repo: `${OWNER}/${EXTRACT_REPO}` });
    assert(view.data.repo.full_name === `${OWNER}/${EXTRACT_REPO}`, 'wrong extracted repo');
    const read = await callTool('github_read', { repo: `${OWNER}/${EXTRACT_REPO}`, path: 'a.txt' });
    assert(read.files?.[0]?.total_lines === 1, 'extracted file missing');
    return 'a.txt present';
  });

  await step('github_file write link fixture', async () => {
    const written = await callTool('github_file', {
      action: 'write', repo: TARGET, branch: 'main', path: LINK_FILE,
      content: 'link fixture\n', message: 'e2e: link fixture', allow_protected: true,
    });
    return written.data.commit;
  });

  let linkPlan = null;
  if (extractConfirmed) {
    linkPlan = await step('github_extract link plan', async () => {
      const plan = await callTool('github_extract', {
        action: 'link',
        source: { repo: TARGET, path: 'link-me' },
        target: { repo: `${OWNER}/${EXTRACT_REPO}` },
        title: `[plugin e2e] link ${RUN}`,
      });
      assert(plan.plan?.confirm, 'link plan confirm missing');
      return plan.plan;
    });
  } else {
    skip('github_extract link plan', 'extraction apply failed, so the link target does not exist');
  }

  if (linkPlan) {
    await step('github_extract link apply', async () => {
      const applied = await callTool('github_extract', {
        action: 'link', apply: true, confirm: linkPlan.confirm,
        source: { repo: TARGET, path: 'link-me' },
        target: { repo: `${OWNER}/${EXTRACT_REPO}` },
        title: `[plugin e2e] link ${RUN}`,
      });
      assert(applied.data.kind === 'extract-link', 'link result missing');
      const match = /\/pull\/(\d+)/.exec(applied.data.pull_request ?? '');
      if (match) {
        linkPrNumber = Number(match[1]);
        evidence.linkPr = applied.data.pull_request;
      }
      return applied.summary;
    });

    await step('github_pr view link PR', async () => {
      assert(linkPrNumber !== null, 'link PR number not parsed');
      const view = await callTool('github_pr', { repo: TARGET, pr: String(linkPrNumber) });
      assert(view.state === 'OPEN', `link PR state ${view.state}`);
      return view.title;
    });

    await step('close link PR and delete branch', async () => {
      await callTool('github_pr', { repo: TARGET, action: 'close', pr: String(linkPrNumber) });
      await callTool('github_ref', {
        action: 'delete', repo: TARGET, ref: LINK_BRANCH, apply: true,
        confirm: `${TARGET}:${LINK_BRANCH}`,
      });
      return 'closed';
    });
  } else {
    skip('github_extract link apply', 'no link plan');
    skip('github_pr view link PR', 'no link plan');
    skip('close link PR and delete branch', 'no link plan');
  }

  await step('github_extract plan multi-path (filter-repo strategy)', async () => {
    const plan = await callTool('github_extract', {
      action: 'plan',
      source: { repo: TARGET, paths: ['extract-me', 'link-me'] },
      destination: { owner: OWNER, name: `${EXTRACT_REPO}-multi`, visibility: 'private' },
      history: 'snapshot',
    });
    assert(plan.plan.details?.strategy === 'filter-repo', `unexpected strategy ${plan.plan.details?.strategy}`);
    assert(plan.plan.warnings.some((warning) => warning.includes('git-filter-repo')), 'filter-repo warning missing');
    return plan.plan.details.strategy;
  });

  await step('github_extract cleanup', async () => {
    const cleaned = await callTool('github_extract', { action: 'cleanup' });
    assert(cleaned.data.kind === 'extract-cleanup', 'cleanup result missing');
    return cleaned.data.path;
  });

  if (extractConfirmed || linkPrNumber !== null) {
    await step('github_extract status journal', async () => {
      const status = await callTool('github_extract', { action: 'status' });
      assert(status.data.items.length >= 1, 'journal has no extraction entries');
      return `${status.data.items.length} entries`;
    });
  } else {
    skip('github_extract status journal', 'no extraction operation was applied');
  }

  // ------------------------------------------------------------------------
  // Local workspace operations
  // ------------------------------------------------------------------------
  await step('github_workspace clone', async () => {
    const cloned = await callTool('github_workspace', {
      action: 'clone', repo: TARGET, path: 'checkout/clanker', depth: 1, set_cwd: false,
    });
    assert(existsSync(join(cloned.data.path, '.git')), 'clone missing .git');
    return cloned.data.path;
  });

  await step('github_workspace status', async () => {
    const status = await callTool('github_workspace', { action: 'status', path: 'checkout/clanker' });
    assert(status.data.kind === 'workspace-status', 'status kind missing');
    assert(status.data.branch === 'main', `unexpected branch ${status.data.branch}`);
    return `${status.data.branch}, clean=${status.data.dirty === 0}`;
  });

  await step('github_workspace status without path from a checkout', async () => {
    const checkout = join(WORK_ROOT, 'checkout', 'clanker');
    process.chdir(checkout);
    try {
      const fresh = createRuntime();
      const status = await callTool('github_workspace', { action: 'status' }, fresh);
      assert(status.data.branch === 'main', `unexpected branch ${status.data.branch}`);
      return status.data.path;
    } finally {
      process.chdir(WORK_ROOT);
    }
  });

  await step('github_workspace list', async () => {
    const list = await callTool('github_workspace', { action: 'list' });
    assert(list.data.items.some((item) => item.repo === TARGET), 'binding missing');
    return `${list.data.items.length} bindings`;
  });

  const mainSha = await step('read main sha for worktree', async () => {
    const view = await callTool('github_ref', { action: 'view', repo: TARGET, ref: 'main' });
    return view.data.sha;
  });

  await step('github_workspace checkout main', async () => {
    const checked = await callTool('github_workspace', {
      action: 'checkout', path: 'checkout/clanker', ref: 'main',
    });
    assert(checked.data.ref === 'main', 'checkout ref mismatch');
    return checked.summary;
  });

  await step('github_workspace sync', async () => {
    const synced = await callTool('github_workspace', {
      action: 'sync', path: 'checkout/clanker', mode: 'ff-only',
    });
    assert(synced.data.mode === '--ff-only', 'sync mode mismatch');
    return synced.summary;
  });

  await step('github_workspace worktree from commit', async () => {
    const worktree = await callTool('github_workspace', {
      action: 'worktree', path: 'checkout/clanker', from: mainSha,
    });
    assert(existsSync(worktree.data.path), 'worktree path missing');
    return worktree.data.path;
  });

  await step('github_workspace bind and unbind', async () => {
    await mkdir(join(WORK_ROOT, 'manual'), { recursive: true });
    const bound = await callTool('github_workspace', {
      action: 'bind', path: 'manual', repo: TARGET,
    });
    assert(bound.data.repo === TARGET, 'bind repo mismatch');
    const unbound = await callTool('github_workspace', {
      action: 'unbind', path: 'manual',
    });
    assert(unbound.data.removed === true, 'unbind did not remove the binding');
    return unbound.summary;
  });

  // ------------------------------------------------------------------------
  // Search, organizations, generic API
  // ------------------------------------------------------------------------
  await step('github_search users', async () => {
    const result = await callTool('github_search', {
      action: 'search', kind: 'users', query: OWNER, limit: 5,
    });
    assert(result.data.items.some((item) => item.login === OWNER), 'user not found');
    return `${result.data.total} users`;
  });

  await step('github_search repositories (index may lag)', async () => {
    const result = await callTool('github_search', {
      action: 'search', kind: 'repositories', query: 'clanker-playground', limit: 10,
    });
    notes.push(`Repository search returned ${result.data.total} results; new repositories may not be indexed yet.`);
    return `${result.data.total} repositories`;
  });

  await step('github_search issues (index may lag)', async () => {
    const result = await callTool('github_search', {
      action: 'search', kind: 'issues', query: `repo:${TARGET} is:issue`, limit: 10,
    });
    return `${result.data.total} issues`;
  });

  await step('github_search code (index may lag)', async () => {
    const result = await callTool('github_search', {
      action: 'search', kind: 'code', query: `repo:${TARGET} PLUGIN_TEST`, limit: 10,
    });
    return `${result.data.total} code results`;
  });

  await step('github_org list', async () => {
    const orgs = await callTool('github_org', { action: 'list' });
    assert(Array.isArray(orgs.data.items), 'org items missing');
    return `${orgs.data.items.length} organizations`;
  });

  await step('github_org view user account (expected failure)', () => callTool('github_org', {
    action: 'view', org: OWNER,
  }), { optional: true });

  await step('github_api GET with select', async () => {
    const response = await callTool('github_api', {
      action: 'request', path: `repos/${TARGET}`, select: 'default_branch',
    });
    assert(response.data.response === 'main', `unexpected default branch ${response.data.response}`);
    return 'main';
  });

  await step('github_api GraphQL query', async () => {
    const response = await callTool('github_api', {
      action: 'request', graphql: 'query { viewer { login } }', select: 'viewer.login',
    });
    assert(response.data.response === OWNER, `unexpected viewer ${response.data.response}`);
    return response.data.response;
  });

  await expectError(
    'github_api write without allow_write is rejected',
    () => callTool('github_api', {
      action: 'request', path: `repos/${TARGET}/labels`, method: 'POST',
      body: { name: `${LABEL}-forbidden`, color: 'ededed' },
    }),
    /Pass allow_write: true/i,
  );

  await step('github_api delete label', async () => {
    const path = `repos/${TARGET}/labels/${LABEL}`;
    const deleted = await callTool('github_api', {
      action: 'request', path, method: 'DELETE', allow_write: true, apply: true, confirm: path,
    });
    assert(deleted.data.kind === 'api', 'delete label result missing');
    return 'label deleted';
  });

  // ------------------------------------------------------------------------
  // Policy gates and approval behavior
  // ------------------------------------------------------------------------
  await step('approval request is recorded', async () => {
    assert(runtime.approval.requests.length > 0, 'no approval requests were made');
    approvals.push(...runtime.approval.requests);
    return `${runtime.approval.requests.length} requests`;
  });

  await step('approval rejection blocks a write', async () => {
    runtime.approval.mode = 'rejected';
    try {
      await callTool('github_issue', {
        repo: TARGET, action: 'comment', issue: String(issueNumber), body: 'must not be posted',
      });
      throw new Error('write was not blocked after rejection');
    } catch (error) {
      if (error.message.includes('must not be posted')) throw error;
      assert(/rejected|nothing was sent/i.test(error.message), `unexpected error: ${error.message}`);
    } finally {
      runtime.approval.mode = 'allowed-once';
    }
    return 'rejected write produced no change';
  });

  await step('destructive gate blocks repo delete when disabled', async () => {
    const hard = createRuntime({
      requireApproval: false,
      allowDestructive: false,
      allowAdmin: false,
      allowGenericApi: 'read',
    });
    let blocked = false;
    try {
      await callTool('github_repo', {
        action: 'delete', repo: scratchName, apply: true, confirm: `DELETE ${scratchName}`,
      }, hard);
    } catch (error) {
      blocked = /destructive operations are disabled/i.test(error.message);
      if (!blocked) throw error;
    }
    assert(blocked, 'destructive operation was not blocked');
    return 'allowDestructive=false blocked apply';
  });

  await step('admin gate blocks secrets when disabled', async () => {
    const hard = createRuntime({
      requireApproval: false,
      allowDestructive: false,
      allowAdmin: false,
      allowGenericApi: 'read',
    });
    let blocked = false;
    try {
      await callTool('github_actions', {
        action: 'secrets_set', repo: TARGET, name: 'BLOCKED_SECRET', from_env: 'PATH',
        apply: true, confirm: `${TARGET}:BLOCKED_SECRET`,
      }, hard);
    } catch (error) {
      blocked = /admin operations are disabled/i.test(error.message);
      if (!blocked) throw error;
    }
    assert(blocked, 'admin operation was not blocked');
    return 'allowAdmin=false blocked secrets_set';
  });

  await step('generic API write gate when allowGenericApi=read', async () => {
    const hard = createRuntime({
      requireApproval: false,
      allowDestructive: false,
      allowAdmin: false,
      allowGenericApi: 'read',
    });
    let blocked = false;
    try {
      await callTool('github_api', {
        action: 'request', path: `repos/${TARGET}/labels`, method: 'POST', allow_write: true,
        body: { name: `${LABEL}-blocked`, color: 'ededed' },
      }, hard);
    } catch (error) {
      blocked = /Generic API writes are disabled/i.test(error.message);
      if (!blocked) throw error;
    }
    assert(blocked, 'generic API write was not blocked');
    return 'allowGenericApi=read blocked POST';
  });

  await step('wrong confirm is rejected', async () => {
    let blocked = false;
    try {
      await callTool('github_repo', {
        action: 'delete', repo: scratchName, apply: true, confirm: 'DELETE wrong/repo',
      });
    } catch (error) {
      blocked = /Confirmation does not match/i.test(error.message);
      if (!blocked) throw error;
    }
    assert(blocked, 'wrong confirm was accepted');
    return 'wrong confirm rejected';
  });
}

async function cleanup() {
  console.log('\nCleanup...');
  const safe = async (name, fn) => {
    try {
      await fn();
      console.log(`cleanup: ${name}`);
    } catch (error) {
      console.log(`cleanup skipped: ${name} — ${error.message}`);
    }
  };

  // Close any issue left open on the target.
  if (issueNumber !== null) {
    await safe('close target issue', () => callTool('github_issue', {
      repo: TARGET, action: 'close', issue: String(issueNumber), state_reason: 'completed',
    }));
  }

  // Remove files the tests added to the target default branch.
  const cleanupFiles = [PR_FILE, PR_MOVED, PR_COMMIT_A, PR_COMMIT_B, MAIN_ADVANCE, WORKFLOW_FILE, EXTRACT_A, EXTRACT_B, LINK_FILE];
  for (const path of cleanupFiles) {
    await safe(`delete ${path}`, () => callTool('github_file', {
      action: 'delete', repo: TARGET, branch: 'main', path,
      message: 'e2e: cleanup fixture', allow_protected: true,
    }));
  }

  // Close any open PRs created by the run.
  for (const number of [prNumber, closePrNumber, linkPrNumber]) {
    if (number === null) continue;
    await safe(`close PR #${number}`, async () => {
      const view = await callTool('github_pr', { repo: TARGET, pr: String(number) });
      if (view.state === 'OPEN') {
        await callTool('github_pr', { repo: TARGET, action: 'close', pr: String(number) });
      }
    });
  }

  // Remove leftover branches.
  for (const branch of [BRANCH, CLOSE_BRANCH, LINK_BRANCH]) {
    await safe(`delete branch ${branch}`, () => callTool('github_ref', {
      action: 'delete', repo: TARGET, ref: branch, apply: true,
      confirm: `${TARGET}:${branch}`,
    }));
  }

  // Restore the target repository's original issue setting.
  if (issuesEnabled) {
    await safe('restore has_issues=false', () => callTool('github_repo', {
      action: 'edit', repo: TARGET, has_issues: false,
    }));
  }

  // Remove release, tag, label, and milestone metadata if the run left them.
  await safe('delete release by tag', async () => { deleteReleaseDirect(TAG); });
  await safe('delete tag', async () => { deleteTagDirect(TAG); });
  await safe('delete label', async () => { deleteLabelDirect(LABEL); });
  await safe('delete milestone', async () => { deleteMilestoneDirect(`Plugin E2E ${RUN}`); });

  // The token has no delete_repo scope, so deleting the scratch and extracted
  // repositories fails with 403. Archive them instead and record the limit.
  const repositories = [...new Set([
    `${OWNER}/${EXTRACT_REPO}`,
    scratchActualName ?? scratchName,
  ].filter(Boolean))];
  for (const full of repositories) {
    await safe(`remove repository ${full}`, async () => {
      if (deleteRepoDirect(full)) return;
      if (!archiveRepoDirect(full)) throw new Error('delete and archive both failed');
      notes.push(`Could not delete ${full}: the gh token lacks the delete_repo scope; the repository was archived instead.`);
    });
  }

  await safe('remove local checkout', () => rm(join(WORK_ROOT, 'checkout'), { recursive: true, force: true }));

  notes.push(`Local test workspace kept at ${WORK_ROOT}.`);
}

function buildReport() {
  return {
    run: RUN,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    target: TARGET,
    scratchRepository: scratchName,
    environment: {
      node: process.version,
      platform: process.platform,
      cwd: WORK_ROOT,
      account: evidence.account,
      rateLimit: evidence.rateLimit,
    },
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === 'pass').length,
      failed: checks.filter((check) => check.status === 'fail').length,
      warned: checks.filter((check) => check.status === 'warn').length,
      skipped: checks.filter((check) => check.status === 'skip').length,
      fatal,
    },
    evidence,
    approvals,
    checks,
    notes,
  };
}

async function main() {
  try {
    await runAll();
  } catch (error) {
    fatal = { message: error?.message ?? String(error), code: error?.code ?? null, step: error?.liveStep ?? null };
    console.error('FATAL', fatal.message);
    if (error?.details) console.error(String(error.details).slice(0, 1000));
  } finally {
    try {
      await cleanup();
    } catch (error) {
      notes.push(`Cleanup failed: ${error.message}`);
    }
  }

  const report = buildReport();
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(LATEST_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`Report: ${REPORT_PATH}`);
  console.log(`Summary: ${report.summary.passed} pass, ${report.summary.failed} fail, ${report.summary.warned} warn, ${report.summary.skipped} skip`);
  if (fatal) console.log(`Fatal: ${fatal.message}`);
  if (report.summary.failed > 0 || fatal) process.exitCode = 1;
}

await main();
