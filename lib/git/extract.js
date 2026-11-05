/**
 * Repository extraction engine.
 *
 * A plan is cheap: it reads the source tree through the API and checks the
 * destination. Apply runs in a scratch clone, never in the user's checkout:
 * `subtree split` preserves history for a single directory, or an orphan branch
 * produces a snapshot. The source repository is never rewritten.
 */

import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHubError } from '../errors.js';
import { runGit } from './exec.js';

function client(ctx) {
  if (!ctx.gh) throw new GitHubError('The GitHub REST client is not available.', { code: 'unsupported' });
  return ctx.gh;
}

function normalizePath(input) {
  const value = String(input ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (value.length === 0) throw new GitHubError('source.path is required.', { code: 'validation' });
  if (value.split('/').some((part) => part === '..' || part === '.' || part.length === 0)) {
    throw new GitHubError(`source.path must stay inside the repository: "${input}".`, { code: 'validation' });
  }
  return value;
}

function requireDestination(destination, session) {
  if (destination === null || typeof destination !== 'object') {
    throw new GitHubError('destination is required, for example { "owner": "my-org", "name": "api" }.', { code: 'validation' });
  }
  const name = String(destination.name ?? '').trim();
  if (name.length === 0) throw new GitHubError('destination.name is required.', { code: 'validation' });
  const owner = String(destination.owner ?? session.auth?.account ?? session.defaults.owner ?? '').trim();
  if (owner.length === 0) throw new GitHubError('destination.owner is required.', { code: 'validation' });
  return {
    owner,
    name,
    visibility: destination.visibility ?? 'private',
    create: destination.create !== false,
  };
}

function sourceUrl(ref) {
  return `https://${ref.host}/${ref.full}.git`;
}

function scratchRoot(ctx, config) {
  const base = config.workspaceRoot ? resolve(config.workspaceRoot) : (ctx.session.cwd ?? process.cwd());
  return resolve(base, config.scratchDir ?? '.dsh/github');
}

function uniqueScratch(root) {
  return resolve(root, 'extract', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}

async function apiRepo(ctx, owner, name) {
  return client(ctx).apiJson(ctx.config, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { signal: ctx.signal });
}

async function destinationExists(ctx, destination) {
  try {
    await apiRepo(ctx, destination.owner, destination.name);
    return true;
  } catch (error) {
    if (error?.code === 'not_found') return false;
    throw error;
  }
}

async function commitInfo(ctx, ref, refName) {
  let value = refName && refName.length > 0 && refName !== 'HEAD' ? refName : null;
  if (value === null) {
    const repo = await apiRepo(ctx, ref.owner, ref.name);
    value = typeof repo?.default_branch === 'string' && repo.default_branch.length > 0 ? repo.default_branch : 'HEAD';
  }
  const commit = await client(ctx).apiJson(ctx.config, `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/commits/${encodeURIComponent(value)}`, {
    signal: ctx.signal,
  });
  if (!commit?.sha || !commit?.commit?.tree?.sha) {
    throw new GitHubError(`Could not resolve ${ref.full}@${value}.`, { code: 'not_found' });
  }
  return { sha: commit.sha, treeSha: commit.commit.tree.sha };
}

async function treeStats(ctx, ref, treeSha, path) {
  const tree = await client(ctx).apiJson(ctx.config, `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/git/trees/${treeSha}?recursive=1`, {
    signal: ctx.signal,
  });
  const prefix = `${path}/`;
  const entries = Array.isArray(tree?.tree) ? tree.tree : [];
  const files = entries.filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix));
  const submodules = entries.filter((entry) => entry.type === 'commit' && entry.path.startsWith(prefix));
  const bytes = files.reduce((total, file) => total + (Number.isFinite(file.size) ? file.size : 0), 0);
  if (files.length === 0 && submodules.length === 0) {
    throw new GitHubError(`No files found at "${path}" in ${ref.full}.`, { code: 'not_found' });
  }
  return {
    files: files.length,
    bytes,
    submodules: submodules.map((entry) => entry.path),
    truncated: tree?.truncated === true,
  };
}

async function treeStatsForPaths(ctx, ref, treeSha, paths) {
  const combined = { files: 0, bytes: 0, submodules: [], truncated: false };
  for (const path of paths) {
    const stats = await treeStats(ctx, ref, treeSha, path);
    combined.files += stats.files;
    combined.bytes += stats.bytes;
    combined.submodules.push(...stats.submodules);
    combined.truncated ||= stats.truncated;
  }
  combined.submodules = [...new Set(combined.submodules)];
  return combined;
}

async function hasLfs(ctx, ref, revision) {
  try {
    const data = await client(ctx).apiJson(ctx.config, `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/contents/.gitattributes?ref=${encodeURIComponent(revision)}`, {
      signal: ctx.signal,
    });
    if (data && typeof data.content === 'string' && data.encoding === 'base64') {
      const text = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      return /filter\s*=\s*lfs/i.test(text);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Normalize and preflight an extraction request without writing anything.
 */
export async function prepareExtraction(ctx, config, args) {
  const source = args.source ?? {};
  const sourceRef = ctx.session.resolveRepo(source.repo ?? args.source_repo ?? args.repo, {
    cwd: ctx.session.cwd,
  });
  const rawPaths = Array.isArray(source.paths) ? source.paths : null;
  const paths = rawPaths
    ? [...new Set(rawPaths.map((path) => normalizePath(path)))]
    : [normalizePath(source.path ?? args.source_path ?? args.path)];
  if (paths.length === 0) throw new GitHubError('source.path or source.paths is required.', { code: 'validation' });
  const pathLabel = paths.join(', ');
  const refName = String(source.ref ?? args.ref ?? '').trim();
  const history = args.history ?? config.extraction.history ?? 'preserve';
  if (history !== 'preserve' && history !== 'snapshot') {
    throw new GitHubError('history must be "preserve" or "snapshot".', { code: 'validation' });
  }
  if (history === 'preserve' && config.extraction.allowHistoryRewrite !== true && args.allow_history_rewrite !== true) {
    throw new GitHubError('History-preserving extraction rewrites commit hashes in a temporary clone and is disabled by extraction.allowHistoryRewrite.', {
      code: 'policy',
      hint: 'Set extraction.allowHistoryRewrite: true (or pass allow_history_rewrite: true) after reviewing the plan, or use history: "snapshot".',
    });
  }

  const destination = requireDestination(args.destination, ctx.session);
  const exists = await destinationExists(ctx, destination);
  if (destination.create && exists) {
    throw new GitHubError(`Destination ${destination.owner}/${destination.name} already exists.`, {
      code: 'conflict',
      hint: 'Set destination.create: false to push into an existing empty repository, or choose another name.',
    });
  }
  if (!destination.create && !exists) {
    throw new GitHubError(`Destination ${destination.owner}/${destination.name} does not exist.`, {
      code: 'not_found',
      hint: 'Create it first, or leave destination.create at its default true.',
    });
  }

  const commit = await commitInfo(ctx, sourceRef, refName);
  const stats = await treeStatsForPaths(ctx, sourceRef, commit.treeSha, paths);
  stats.lfs = await hasLfs(ctx, sourceRef, commit.sha);
  const strategy = paths.length > 1 ? 'filter-repo' : (history === 'snapshot' ? 'snapshot' : 'subtree-split');
  return {
    source: sourceRef,
    sourceRef: refName || 'default branch',
    sourceSha: commit.sha,
    path: paths[0],
    paths,
    pathLabel,
    history,
    strategy,
    destination,
    stats,
    args,
  };
}

/** Build the model-facing plan. */
export function buildExtractionPlan(prepared) {
  const { source, destination, paths, pathLabel, history, strategy, stats, sourceSha } = prepared;
  const warnings = [];
  if (stats.truncated) warnings.push('GitHub truncated the source tree; file counts are lower bounds.');
  if (history === 'preserve') warnings.push('Commit hashes in the new repository will differ from the source.');
  else warnings.push('Snapshot mode creates one import commit; source history is not preserved.');
  if (stats.submodules.length > 0) warnings.push(`The path contains ${stats.submodules.length} submodule(s); their histories are not copied.`);
  if (stats.lfs) warnings.push('LFS attributes detected; apply requires git-lfs and fetches/pushes the LFS objects.');
  if (strategy === 'filter-repo') warnings.push('Multi-path extraction uses git-filter-repo and must be available on PATH.');
  return {
    summary: `Extract ${pathLabel} from ${source.full} into ${destination.owner}/${destination.name} (${history})`,
    risk: 'destructive',
    effects: [
      `Create ${destination.owner}/${destination.name}`,
      `Run ${strategy} in a temporary clone at ${sourceSha.slice(0, 7)}`,
      `Push ${history === 'preserve' ? 'rewritten history' : 'a snapshot'} to main`,
    ],
    warnings,
    confirm: `${source.full}:${pathLabel} -> ${destination.owner}/${destination.name}`,
    source: { repo: source.full, ref: prepared.sourceRef, sha: sourceSha, paths },
    destination,
    history,
    strategy,
    stats,
  };
}

async function createDestination(ctx, destination) {
  if (!destination.create) return null;
  const account = ctx.session.auth?.account ?? ctx.session.defaults?.owner ?? null;
  if (account === null) {
    throw new GitHubError('Could not resolve the signed-in GitHub account for the destination repository.', {
      code: 'auth',
      hint: 'Run github_status to check the gh login, or pass destination.create: false with a pre-created repository.',
    });
  }
  const payload = {
    name: destination.name,
    private: destination.visibility !== 'public',
    visibility: destination.visibility,
    auto_init: false,
    description: `Extracted from ${destination.source ?? 'another repository'}`,
  };
  const endpoint = destination.owner === account
    ? 'user/repos'
    : `orgs/${encodeURIComponent(destination.owner)}/repos`;
  return client(ctx).apiJson(ctx.config, endpoint, { method: 'POST', input: payload, signal: ctx.signal });
}

async function deleteDestination(ctx, destination) {
  try {
    await client(ctx).apiJson(ctx.config, `repos/${encodeURIComponent(destination.owner)}/${encodeURIComponent(destination.name)}`, {
      method: 'DELETE',
      signal: ctx.signal,
    });
    return true;
  } catch {
    return false;
  }
}

async function git(ctx, config, args, cwd, options = {}) {
  return runGit(ctx, config, args, {
    cwd,
    agent: ctx.agent,
    signal: ctx.signal,
    timeoutMs: config.longTimeoutMs,
    maxBytes: 512 * 1024,
    allowCodes: options.allowCodes ?? [0],
  });
}

/**
 * Execute a prepared extraction in a scratch clone.
 *
 * @returns {Promise<object>} applied result.
 */
export async function applyExtraction(ctx, config, prepared) {
  const root = scratchRoot(ctx, config);
  const scratch = uniqueScratch(root);
  const sourceDir = resolve(scratch, 'source');
  await mkdir(scratch, { recursive: true });
  let created = false;
  let destinationCreated = false;

  try {
    created = true;
    if (prepared.destination.create) {
      await createDestination(ctx, { ...prepared.destination, source: prepared.source.full });
      destinationCreated = true;
    }

    await git(ctx, config, ['clone', '--no-local', '--quiet', sourceUrl(prepared.source), sourceDir], scratch);
    if (prepared.sourceRef && prepared.sourceRef !== 'default branch') {
      await git(ctx, config, ['fetch', '--quiet', 'origin', prepared.sourceRef], sourceDir);
      await git(ctx, config, ['checkout', '--quiet', 'FETCH_HEAD'], sourceDir);
    }
    const head = await git(ctx, config, ['rev-parse', 'HEAD'], sourceDir);
    const sha = head.stdout.trim();

    if (prepared.stats.lfs) {
      const lfs = await git(ctx, config, ['lfs', 'version'], sourceDir, { allowCodes: [0, 1] });
      if (lfs.code !== 0) {
        throw new GitHubError('This repository uses Git LFS, but git-lfs is not installed.', {
          code: 'unsupported',
          hint: 'Install git-lfs and retry, or extract with history: "snapshot" and handle LFS manually.',
        });
      }
      await git(ctx, config, ['lfs', 'fetch', '--all'], sourceDir);
    }

    let branch;
    if (prepared.strategy === 'filter-repo') {
      const filterArgs = ['filter-repo', '--force'];
      for (const path of prepared.paths) filterArgs.push('--path', path);
      await git(ctx, config, filterArgs, sourceDir);
      branch = 'HEAD';
    } else {
      await git(ctx, config, ['subtree', 'split', `--prefix=${prepared.path}`, '-b', 'dsh-split', 'HEAD'], sourceDir);
      branch = 'dsh-split';
    }
    if (prepared.history === 'snapshot') {
      await git(ctx, config, ['checkout', '--orphan', 'dsh-snapshot', branch], sourceDir);
      await git(ctx, config, [
        '-c', 'user.name=dsh-github-cli',
        '-c', 'user.email=dsh-github-cli@users.noreply.github.com',
        'commit', '-m', `Import ${prepared.pathLabel} from ${prepared.source.full}@${sha}`,
      ], sourceDir);
      branch = 'dsh-snapshot';
    }

    const destinationUrl = `https://${prepared.source.host}/${prepared.destination.owner}/${prepared.destination.name}.git`;
    await git(ctx, config, ['push', destinationUrl, `${branch}:refs/heads/main`], sourceDir);
    if (prepared.stats.lfs) {
      await git(ctx, config, ['lfs', 'push', '--all', destinationUrl], sourceDir);
    }

    const repo = await apiRepo(ctx, prepared.destination.owner, prepared.destination.name);
    return {
      repo: `${prepared.destination.owner}/${prepared.destination.name}`,
      url: repo?.html_url ?? null,
      summary: `Extracted ${prepared.pathLabel} from ${prepared.source.full} into ${prepared.destination.owner}/${prepared.destination.name}`,
      data: {
        kind: 'extract',
        destination: `${prepared.destination.owner}/${prepared.destination.name}`,
        default_branch: 'main',
        strategy: prepared.strategy,
        history: prepared.history,
        source_sha: sha,
      },
    };
  } catch (error) {
    let cleanup = false;
    if (destinationCreated) cleanup = await deleteDestination(ctx, prepared.destination);
    const hint = cleanup
      ? 'The destination repository created by this attempt was removed.'
      : 'The destination repository may need manual cleanup.';
    if (error instanceof GitHubError) {
      error.hint = `${error.hint ?? ''} ${hint}`.trim();
      throw error;
    }
    throw new GitHubError(`Extraction failed: ${error.message}. ${hint}`, {
      code: 'partial',
      details: String(error.stack ?? error.message).slice(0, 2000),
      cause: error,
    });
  } finally {
    if (created) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
