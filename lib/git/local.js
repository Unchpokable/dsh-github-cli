/**
 * Local workspace operations: clone, checkout, sync, status, bind, worktree.
 *
 * These functions are deliberately small and return plain facts. The operation
 * layer owns risk, approval, and rendering; a tool call can explain what would
 * happen before any files are written.
 */

import { join, resolve } from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { runGit, isInside } from './exec.js';
import { GitHubError } from '../errors.js';
import { parsePull, parseRepoRef } from '../repo.js';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function makeDirectory(ctx, path) {
  const fs = ctx?.session?.ctx?.get?.('fs');
  if (fs && typeof fs.mkdir === 'function') {
    await fs.mkdir(path, { recursive: true });
    return;
  }
  await mkdir(path, { recursive: true });
}

function workingDirectoryService(ctx) {
  return ctx?.session?.ctx?.get?.('workingDirectory') ?? ctx?.workingDirectory ?? null;
}

function rootFor(ctx, config = {}) {
  return config.workspaceRoot && config.workspaceRoot.trim().length > 0
    ? resolve(config.workspaceRoot)
    : (ctx.session?.cwd ?? process.cwd());
}

function remoteUrl(ref) {
  return `https://${ref.host}/${ref.full}.git`;
}

function cloneDestination(ctx, config, ref, requested) {
  const root = rootFor(ctx, config);
  const destination = requested
    ? resolveWorkspacePathSync(root, requested)
    : join(root, ref.owner, ref.name);
  if (!isInside(root, destination)) {
    throw new GitHubError(`clone destination must stay inside ${root}.`, {
      code: 'validation',
      hint: 'Pass a path under workspaceRoot or the session working directory.',
    });
  }
  return destination;
}

function resolveWorkspacePathSync(root, input) {
  return input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input) ? resolve(input) : resolve(root, input);
}

/**
 * Clone a repository into the workspace.
 *
 * @returns {Promise<{path: string, repo: string, branch: string|null}>}
 */
export async function cloneRepository(ctx, config, args = {}) {
  const ref = ctx.session.resolveRepo(args.repo, { cwd: ctx.session.cwd });
  const destination = cloneDestination(ctx, config, ref, args.path);
  if (await exists(destination)) {
    throw new GitHubError(`Destination already exists: ${destination}.`, { code: 'conflict' });
  }

  const gitArgs = ['clone', '--origin', 'origin'];
  if (typeof args.branch === 'string' && args.branch.trim().length > 0) gitArgs.push('--branch', args.branch.trim());
  if (Number.isInteger(args.depth) && args.depth > 0) gitArgs.push('--depth', String(args.depth));
  if (args.submodules === true) gitArgs.push('--recurse-submodules');
  gitArgs.push(remoteUrl(ref), destination);

  const parent = resolve(destination, '..');
  if (!(await exists(parent))) await makeDirectory(ctx, parent);
  await runGit(ctx, config, gitArgs, {
    cwd: rootFor(ctx, config),
    agent: ctx.agent,
    signal: ctx.signal,
    timeoutMs: config.longTimeoutMs,
    allowCodes: [0],
  });

  ctx.session.bind(destination, ref.full);
  const wd = workingDirectoryService(ctx);
  if (args.set_cwd !== false && ctx.agent && wd) {
    await wd.set(ctx.agent, destination, ctx.signal);
  }
  return { path: destination, repo: ref.full, branch: args.branch ?? null };
}

/**
 * Switch a checkout to a branch, tag, commit, or pull request head.
 *
 * @returns {Promise<{path: string, ref: string, pr: number|null}>}
 */
export async function checkout(ctx, config, args = {}) {
  const path = args.path
    ? resolveWorkspacePathSync(rootFor(ctx, config), args.path)
    : (ctx.session.cwd ?? process.cwd());
  if (!(await exists(path))) throw new GitHubError(`Checkout does not exist: ${path}.`, { code: 'not_found' });

  if (args.pr !== undefined) {
    const pull = parsePull(args.pr);
    const branch = typeof args.branch === 'string' && args.branch.trim().length > 0
      ? args.branch.trim()
      : `pr-${pull.number}`;
    await runGit(ctx, config, ['fetch', 'origin', `pull/${pull.number}/head:${branch}`], {
      cwd: path,
      agent: ctx.agent,
      signal: ctx.signal,
      timeoutMs: config.longTimeoutMs,
    });
    await runGit(ctx, config, ['switch', branch], { cwd: path, agent: ctx.agent, signal: ctx.signal });
    return { path, ref: branch, pr: pull.number };
  }

  const ref = String(args.ref ?? args.branch ?? '').trim();
  if (ref.length === 0) throw new GitHubError('ref or pr is required for checkout.', { code: 'validation' });

  if (args.worktree === true) {
    const name = ref.replace(/[\\/:]/g, '-');
    const destination = join(path, '.dsh', 'worktrees', name);
    if (await exists(destination)) throw new GitHubError(`Worktree already exists: ${destination}.`, { code: 'conflict' });
    await makeDirectory(ctx, join(path, '.dsh', 'worktrees'));
    await runGit(ctx, config, ['worktree', 'add', '-b', name, destination, ref], {
      cwd: path,
      agent: ctx.agent,
      signal: ctx.signal,
      timeoutMs: config.longTimeoutMs,
    });
    const sourceBinding = await ctx.session.detectBinding(path, ctx.signal);
    if (sourceBinding !== null) ctx.session.bind(destination, sourceBinding.repo);
    const wd = workingDirectoryService(ctx);
    if (ctx.agent && wd) await wd.set(ctx.agent, destination, ctx.signal);
    return { path: destination, ref: name, pr: null };
  }

  await runGit(ctx, config, ['fetch', '--all', '--prune'], {
    cwd: path,
    agent: ctx.agent,
    signal: ctx.signal,
    timeoutMs: config.longTimeoutMs,
  });
  try {
    await runGit(ctx, config, ['switch', ref], { cwd: path, agent: ctx.agent, signal: ctx.signal });
  } catch (error) {
    if (error?.code !== 'git') throw error;
    await runGit(ctx, config, ['checkout', ref], { cwd: path, agent: ctx.agent, signal: ctx.signal });
  }
  return { path, ref, pr: null };
}

/**
 * Fetch and update a checkout without ever forcing a branch.
 */
export async function sync(ctx, config, args = {}) {
  const path = args.path
    ? resolveWorkspacePathSync(rootFor(ctx, config), args.path)
    : (ctx.session.cwd ?? process.cwd());
  if (!(await exists(path))) throw new GitHubError(`Checkout does not exist: ${path}.`, { code: 'not_found' });

  if (args.allow_dirty !== true) {
    const dirty = await runGit(ctx, config, ['status', '--porcelain'], { cwd: path, agent: ctx.agent, signal: ctx.signal });
    if (dirty.stdout.trim().length > 0) {
      throw new GitHubError('The checkout has uncommitted changes; sync would risk them.', {
        code: 'conflict',
        hint: 'Commit or stash the changes, or pass allow_dirty: true after reviewing the risk.',
      });
    }
  }

  await runGit(ctx, config, ['fetch', '--prune'], {
    cwd: path,
    agent: ctx.agent,
    signal: ctx.signal,
    timeoutMs: config.longTimeoutMs,
  });
  const mode = args.mode === 'rebase' ? '--rebase' : (args.mode === 'merge' ? '--no-rebase' : '--ff-only');
  await runGit(ctx, config, ['pull', mode], {
    cwd: path,
    agent: ctx.agent,
    signal: ctx.signal,
    timeoutMs: config.longTimeoutMs,
  });
  return { path, mode };
}

/**
 * Read branch, dirty state, and ahead/behind facts for one checkout.
 */
export async function workspaceStatus(ctx, config, args = {}) {
  const path = args.path
    ? resolveWorkspacePathSync(rootFor(ctx, config), args.path)
    : (ctx.session.cwd ?? process.cwd());
  if (!(await exists(path))) throw new GitHubError(`Checkout does not exist: ${path}.`, { code: 'not_found' });

  const status = await runGit(ctx, config, ['status', '--porcelain=v1', '-b'], {
    cwd: path,
    agent: ctx.agent,
    signal: ctx.signal,
  });
  const lines = status.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const header = lines[0]?.startsWith('##') ? lines.shift().slice(3) : '';
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  if (header.length > 0) {
    const match = /^([^.\s]+)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/.exec(header);
    if (match) {
      branch = match[1] === 'HEAD' ? null : match[1];
      upstream = match[2] ?? null;
      const counts = /ahead (\d+)/.exec(match[3] ?? '');
      const behindMatch = /behind (\d+)/.exec(match[3] ?? '');
      if (counts) ahead = Number(counts[1]);
      if (behindMatch) behind = Number(behindMatch[1]);
    }
  }

  const remotes = await runGit(ctx, config, ['remote', '-v'], { cwd: path, agent: ctx.agent, signal: ctx.signal });
  const binding = ctx.session.bindings.get(path) ?? null;
  return {
    path,
    branch,
    upstream,
    ahead,
    behind,
    dirty: lines.length,
    changes: lines.slice(0, 50),
    repo: binding?.repo ?? null,
    remotes: remotes.stdout.split(/\r?\n/).filter(Boolean).length / 2,
  };
}

/** Bind a checkout to a repository, or detect it from the git remote. */
export async function bindWorkspace(ctx, config, args = {}) {
  const path = args.path
    ? resolveWorkspacePathSync(rootFor(ctx, config), args.path)
    : (ctx.session.cwd ?? process.cwd());
  if (args.repo) {
    const ref = parseRepoRef(args.repo, config.defaultHost);
    return ctx.session.bind(path, ref.full, args.remote ?? 'origin');
  }
  const binding = await ctx.session.detectBinding(path, ctx.signal);
  if (binding === null) throw new GitHubError(`No GitHub remote found in ${path}.`, { code: 'not_found' });
  return binding;
}

/** List known bindings. */
export function listWorkspaces(ctx) {
  return [...ctx.session.bindings.values()];
}

/** Remove a binding without touching the checkout. */
export function unbindWorkspace(ctx, args = {}) {
  const path = args.path
    ? resolveWorkspacePathSync(rootFor(ctx, {}), args.path)
    : (ctx.session.cwd ?? process.cwd());
  const removed = ctx.session.bindings.delete(path);
  return { path, removed };
}
