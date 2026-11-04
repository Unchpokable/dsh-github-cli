/**
 * `github_extract` operations: plan and apply.
 *
 * Plan reads the source tree via the API and checks the destination. Apply runs
 * in a scratch clone so the user's checkout and the source repository are never
 * rewritten.
 */

import { defineOperation } from './registry.js';
import { buildExtractionPlan, prepareExtraction, applyExtraction } from '../git/extract.js';
import { GitHubError } from '../errors.js';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isInside } from '../git/exec.js';

function client(ctx) {
  if (!ctx.gh) throw new GitHubError('The GitHub REST client is not available.', { code: 'unsupported' });
  return ctx.gh;
}

function repoPath(ref, suffix = '') {
  return `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}${suffix}`;
}

function normalizePath(input) {
  const value = String(input ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (value.length === 0 || value.split('/').some((part) => part === '..' || part === '.' || part.length === 0)) {
    throw new GitHubError('source.path must be a repository-relative directory.', { code: 'validation' });
  }
  return value;
}

async function repoInfo(ctx, ref) {
  const repo = await client(ctx).apiJson(ctx.config, repoPath(ref), { signal: ctx.signal });
  if (!repo?.default_branch) throw new GitHubError(`Could not resolve ${ref.full}.`, { code: 'not_found' });
  return repo;
}

async function commitAt(ctx, ref, revision) {
  const commit = await client(ctx).apiJson(ctx.config, repoPath(ref, `/commits/${encodeURIComponent(revision)}`), {
    signal: ctx.signal,
  });
  if (!commit?.sha || !commit?.commit?.tree?.sha) {
    throw new GitHubError(`Could not resolve ${ref.full}@${revision}.`, { code: 'not_found' });
  }
  return { sha: commit.sha, tree: commit.commit.tree.sha };
}

async function treeFiles(ctx, ref, tree, path) {
  const value = await client(ctx).apiJson(ctx.config, repoPath(ref, `/git/trees/${tree}?recursive=1`), { signal: ctx.signal });
  if (value?.truncated) {
    throw new GitHubError('The source tree is truncated; link cannot safely replace this directory.', {
      code: 'unsupported',
      hint: 'Use a narrower path or run the link manually.',
    });
  }
  const prefix = `${path}/`;
  return (Array.isArray(value?.tree) ? value.tree : [])
    .filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix))
    .map((entry) => entry.path);
}

async function existingGitmodules(ctx, ref, revision) {
  try {
    const data = await client(ctx).apiJson(ctx.config, repoPath(ref, `/contents/.gitmodules?ref=${encodeURIComponent(revision)}`), {
      signal: ctx.signal,
    });
    if (data && typeof data.content === 'string' && data.encoding === 'base64') {
      return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    }
  } catch (error) {
    if (error?.code !== 'not_found') throw error;
  }
  return null;
}

async function prepareLink(ctx, args) {
  const source = args.source ?? {};
  const sourceRef = ctx.session.resolveRepo(source.repo ?? args.source_repo, { cwd: ctx.session.cwd });
  const targetRef = ctx.session.resolveRepo(args.target?.repo ?? args.target_repo, { cwd: ctx.session.cwd });
  if (sourceRef.full === targetRef.full) throw new GitHubError('source and target must be different repositories.', { code: 'validation' });
  const path = normalizePath(source.path ?? args.source_path);
  const sourceRepo = await repoInfo(ctx, sourceRef);
  const targetRepo = await repoInfo(ctx, targetRef);
  const revision = String(source.ref ?? args.ref ?? sourceRepo.default_branch).trim();
  const sourceCommit = await commitAt(ctx, sourceRef, revision);
  const targetCommit = await commitAt(ctx, targetRef, targetRepo.default_branch);
  const files = await treeFiles(ctx, sourceRef, sourceCommit.tree, path);
  if (files.length === 0) throw new GitHubError(`No files found at "${path}" in ${sourceRef.full}.`, { code: 'not_found' });
  const gitmodules = await existingGitmodules(ctx, sourceRef, sourceCommit.sha);
  if (gitmodules !== null && gitmodules.includes(`[submodule "${path}"]`)) {
    throw new GitHubError(`"${path}" is already a submodule in .gitmodules.`, { code: 'conflict' });
  }
  const slug = path.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'submodule';
  const branch = String(args.branch ?? `dsh/link-${slug}`).trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new GitHubError('branch contains invalid characters.', { code: 'validation' });
  return {
    sourceRef,
    targetRef,
    path,
    revision,
    sourceCommit,
    targetCommit,
    targetRepo,
    files,
    gitmodules,
    branch,
    sourceDefault: sourceRepo.default_branch,
    args,
  };
}

function linkPlan(prepared) {
  return {
    summary: `Link ${prepared.targetRef.full} as a submodule at ${prepared.path} in ${prepared.sourceRef.full}`,
    risk: 'destructive',
    effects: [
      `Remove ${prepared.files.length} file(s) from ${prepared.path}`,
      `Add a gitlink to ${prepared.targetRef.full}@${prepared.targetCommit.sha.slice(0, 7)}`,
      `Update .gitmodules`,
      `Create branch ${prepared.branch} and open a pull request`,
    ],
    warnings: ['The existing files in the source branch are replaced by a submodule.'],
    confirm: `${prepared.sourceRef.full}:${prepared.path} <- ${prepared.targetRef.full}`,
    details: {
      source: { repo: prepared.sourceRef.full, ref: prepared.revision, sha: prepared.sourceCommit.sha, path: prepared.path },
      target: { repo: prepared.targetRef.full, sha: prepared.targetCommit.sha },
      files: prepared.files.length,
      branch: prepared.branch,
    },
  };
}

async function applyLink(ctx, prepared) {
  const targetUrl = prepared.targetRepo.clone_url ?? `https://${prepared.targetRef.host}/${prepared.targetRef.full}.git`;
  const section = `[submodule "${prepared.path}"]\n\tpath = ${prepared.path}\n\turl = ${targetUrl}\n`;
  const content = prepared.gitmodules === null ? section : `${prepared.gitmodules.replace(/\s+$/, '')}\n\n${section}`;
  const blob = await client(ctx).apiJson(ctx.config, repoPath(prepared.sourceRef, '/git/blobs'), {
    method: 'POST',
    input: { content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' },
    signal: ctx.signal,
  });
  const treeEntries = prepared.files.map((file) => ({ path: file, mode: '100644', type: 'blob', sha: null }));
  treeEntries.push({ path: '.gitmodules', mode: '100644', type: 'blob', sha: blob.sha });
  treeEntries.push({ path: prepared.path, mode: '160000', type: 'commit', sha: prepared.targetCommit.sha });
  const tree = await client(ctx).apiJson(ctx.config, repoPath(prepared.sourceRef, '/git/trees'), {
    method: 'POST',
    input: { base_tree: prepared.sourceCommit.tree, tree: treeEntries },
    signal: ctx.signal,
  });
  const commit = await client(ctx).apiJson(ctx.config, repoPath(prepared.sourceRef, '/git/commits'), {
    method: 'POST',
    input: {
      message: prepared.args.message ?? `Link ${prepared.path} to ${prepared.targetRef.full}`,
      tree: tree.sha,
      parents: [prepared.sourceCommit.sha],
    },
    signal: ctx.signal,
  });
  await client(ctx).apiJson(ctx.config, repoPath(prepared.sourceRef, '/git/refs'), {
    method: 'POST',
    input: { ref: `refs/heads/${prepared.branch}`, sha: commit.sha },
    signal: ctx.signal,
  });

  let pull = null;
  if (prepared.args.open_pr !== false) {
    pull = await client(ctx).apiJson(ctx.config, repoPath(prepared.sourceRef, '/pulls'), {
      method: 'POST',
      input: {
        title: prepared.args.title ?? `Link ${prepared.path} as a submodule`,
        head: prepared.branch,
        base: prepared.sourceDefault,
        body: `Replaces \`${prepared.path}\` with a submodule pointing at ${prepared.targetRef.full}.`,
      },
      signal: ctx.signal,
    });
  }

  return {
    repo: prepared.sourceRef.full,
    url: pull?.html_url ?? null,
    summary: `Linked ${prepared.targetRef.full} at ${prepared.path} on ${prepared.branch}`,
    data: {
      kind: 'extract-link',
      source: prepared.sourceRef.full,
      target: prepared.targetRef.full,
      path: prepared.path,
      branch: prepared.branch,
      commit: commit.sha,
      pull_request: pull?.html_url ?? null,
    },
  };
}

defineOperation({
  tool: 'github_extract',
  action: 'link',
  risk: 'destructive',
  async prepare(ctx, args) {
    return { ...(await prepareLink(ctx, args)), repo: args.source?.repo ?? args.source_repo };
  },
  async plan(ctx, prepared) {
    return linkPlan(prepared);
  },
  async apply(ctx, prepared) {
    return applyLink(ctx, prepared);
  },
});

function details(plan) {
  return {
    source: plan.source,
    destination: plan.destination,
    history: plan.history,
    strategy: plan.strategy,
    stats: plan.stats,
  };
}

defineOperation({
  tool: 'github_extract',
  action: 'plan',
  risk: 'destructive',
  async prepare(ctx, args) {
    const prepared = await prepareExtraction(ctx, ctx.config, args);
    return { ...prepared, repo: `${prepared.destination.owner}/${prepared.destination.name}` };
  },
  async plan(ctx, prepared) {
    const plan = buildExtractionPlan(prepared);
    return { ...plan, details: details(plan) };
  },
  async apply() {
    throw new Error('Use action=apply with the plan confirm string.');
  },
});

defineOperation({
  tool: 'github_extract',
  action: 'apply',
  risk: 'destructive',
  async prepare(ctx, args) {
    if (args.confirm === undefined) {
      throw new Error('confirm is required for extraction apply; request action=plan first.');
    }
    const prepared = await prepareExtraction(ctx, ctx.config, args);
    return { ...prepared, repo: `${prepared.destination.owner}/${prepared.destination.name}` };
  },
  async plan(ctx, prepared) {
    const plan = buildExtractionPlan(prepared);
    return { ...plan, details: details(plan) };
  },
  async apply(ctx, prepared) {
    return applyExtraction(ctx, ctx.config, prepared);
  },
});

defineOperation({
  tool: 'github_extract',
  action: 'cleanup',
  risk: 'local',
  async prepare(ctx, args) {
    const base = resolve(ctx.config.workspaceRoot || ctx.session.cwd || process.cwd(), ctx.config.scratchDir ?? '.dsh/github', 'extract');
    const target = args.path
      ? resolve(base, String(args.path))
      : base;
    if (!isInside(base, target)) throw new GitHubError('cleanup path must stay under the extraction scratch directory.', { code: 'policy' });
    return { base, target, args };
  },
  async apply(ctx, prepared) {
    await rm(prepared.target, { recursive: true, force: true });
    return {
      summary: `Removed extraction scratch ${prepared.target}`,
      data: { kind: 'extract-cleanup', path: prepared.target },
    };
  },
});

defineOperation({
  tool: 'github_extract',
  action: 'status',
  risk: 'read',
  async prepare(ctx, args) {
    return { args };
  },
  async apply(ctx) {
    const items = (ctx.session.journal ?? [])
      .filter((entry) => String(entry.operation ?? '').startsWith('extract.'))
      .slice(-20)
      .map((entry) => ({
        id: entry.id,
        operation: entry.operation,
        repo: entry.repo,
        risk: entry.risk,
        result: entry.result,
        at: entry.at,
      }));
    return {
      summary: `${items.length} extraction operation${items.length === 1 ? '' : 's'}`,
      data: { kind: 'extract-status', items, total: items.length, truncated: false },
    };
  },
});
