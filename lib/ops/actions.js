/**
 * GitHub Actions: workflows, runs, dispatch, rerun/cancel, logs, artifacts,
 * secrets, variables, caches, permissions, and runners.
 *
 * Secret values never appear in tool arguments: `secrets_set` reads `from_file`
 * or `from_env` and forwards the value to `gh secret set` over stdin.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineOperation } from './registry.js';
import { GitHubError } from '../errors.js';
import { isInside } from '../git/exec.js';
import { tailLines } from '../result.js';

function client(ctx) {
  if (!ctx.gh) throw new GitHubError('The GitHub REST client is not available.', { code: 'unsupported' });
  return ctx.gh;
}

function repoFor(ctx, args) {
  return ctx.session.resolveRepo(args.repo, { cwd: ctx.session.cwd });
}

function repoPath(ref, suffix = '') {
  return `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}${suffix}`;
}

function projectWorkflow(workflow) {
  return {
    id: workflow.id ?? null,
    name: workflow.name ?? '',
    path: workflow.path ?? null,
    state: workflow.state ?? null,
    html_url: workflow.html_url ?? null,
  };
}

function projectRun(run) {
  return {
    id: run.id ?? null,
    name: run.name ?? run.display_title ?? '',
    event: run.event ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    branch: run.head_branch ?? null,
    sha: run.head_sha ?? null,
    workflow_id: run.workflow_id ?? null,
    run_number: run.run_number ?? null,
    html_url: run.html_url ?? null,
    created_at: run.created_at ?? null,
    updated_at: run.updated_at ?? null,
  };
}

function workflowEndpoint(ref, workflow) {
  return repoPath(ref, `/actions/workflows/${encodeURIComponent(String(workflow))}`);
}

defineOperation({
  tool: 'github_actions',
  action: 'workflows',
  risk: 'read',
  async prepare(ctx, args) {
    return { ref: repoFor(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const data = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, '/actions/workflows'), { signal: ctx.signal });
    const items = Array.isArray(data?.workflows) ? data.workflows.map(projectWorkflow) : [];
    return {
      repo: prepared.ref.full,
      summary: `${items.length} workflow${items.length === 1 ? '' : 's'} in ${prepared.ref.full}`,
      data: { kind: 'workflow-list', items, total: data?.total_count ?? items.length, truncated: false },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'workflow',
  risk: 'read',
  async prepare(ctx, args) {
    const workflow = String(args.workflow ?? '').trim();
    if (workflow.length === 0) throw new GitHubError('workflow is required.', { code: 'validation' });
    return { ref: repoFor(ctx, args), workflow, args };
  },
  async apply(ctx, prepared) {
    const workflow = await client(ctx).apiJson(ctx.config, workflowEndpoint(prepared.ref, prepared.workflow), { signal: ctx.signal });
    return {
      repo: prepared.ref.full,
      summary: `Workflow ${workflow?.name ?? prepared.workflow}`,
      data: { kind: 'workflow', workflow: projectWorkflow(workflow) },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'runs',
  risk: 'read',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    let workflowId = Number.isInteger(args.workflow_id) ? args.workflow_id : null;
    if (workflowId === null && typeof args.workflow === 'string' && args.workflow.trim().length > 0) {
      const workflow = await client(ctx).apiJson(ctx.config, workflowEndpoint(ref, args.workflow.trim()), { signal: ctx.signal });
      workflowId = Number.isInteger(workflow?.id) ? workflow.id : null;
    }
    return { ref, workflowId, args };
  },
  async apply(ctx, prepared) {
    const query = new URLSearchParams();
    if (prepared.workflowId !== null) query.set('workflow_id', String(prepared.workflowId));
    for (const field of ['branch', 'status', 'event', 'actor']) {
      if (prepared.args[field]) query.set(field, String(prepared.args[field]));
    }
    const data = await client(ctx).apiJson(ctx.config, `${repoPath(prepared.ref, '/actions/runs')}?${query}`, { signal: ctx.signal });
    const items = Array.isArray(data?.workflow_runs) ? data.workflow_runs.map(projectRun) : [];
    const limit = Number.isInteger(prepared.args.limit) && prepared.args.limit > 0 ? Math.min(prepared.args.limit, 100) : 30;
    const visible = items.slice(0, limit);
    return {
      repo: prepared.ref.full,
      summary: `${visible.length} workflow run${visible.length === 1 ? '' : 's'} in ${prepared.ref.full}`,
      data: { kind: 'run-list', items: visible, total: data?.total_count ?? items.length, truncated: items.length > visible.length },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'run',
  risk: 'read',
  async prepare(ctx, args) {
    const id = Number(args.run_id);
    if (!Number.isInteger(id) || id <= 0) throw new GitHubError('run_id must be a positive integer.', { code: 'validation' });
    return { ref: repoFor(ctx, args), id, args };
  },
  async apply(ctx, prepared) {
    const run = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/actions/runs/${prepared.id}`), { signal: ctx.signal });
    let jobs = null;
    if (prepared.args.include_jobs === true) {
      const data = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/actions/runs/${prepared.id}/jobs?filter=latest`), { signal: ctx.signal });
      jobs = Array.isArray(data?.jobs)
        ? data.jobs.map((job) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, html_url: job.html_url }))
        : [];
    }
    return {
      repo: prepared.ref.full,
      summary: `Run ${prepared.id}: ${run?.status ?? 'unknown'}${run?.conclusion ? `/${run.conclusion}` : ''}`,
      url: run?.html_url ?? null,
      data: { kind: 'run', run: projectRun(run), jobs },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'dispatch',
  risk: 'write',
  async prepare(ctx, args) {
    const workflow = String(args.workflow ?? '').trim();
    const refName = String(args.ref ?? '').trim();
    if (workflow.length === 0) throw new GitHubError('workflow is required.', { code: 'validation' });
    if (refName.length === 0) throw new GitHubError('ref is required for dispatch.', { code: 'validation' });
    return { ref: repoFor(ctx, args), workflow, refName, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Dispatch ${prepared.workflow} on ${prepared.refName}`,
      effects: [`Trigger workflow ${prepared.workflow}`, `Inputs: ${Object.keys(prepared.args.inputs ?? {}).join(', ') || 'none'}`],
      warnings: ['Workflow dispatch is not idempotent; retrying can start another run.'],
    };
  },
  async apply(ctx, prepared) {
    await client(ctx).apiJson(ctx.config, `${workflowEndpoint(prepared.ref, prepared.workflow)}/dispatches`, {
      method: 'POST',
      input: { ref: prepared.refName, inputs: prepared.args.inputs ?? {} },
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Dispatched ${prepared.workflow} on ${prepared.refName}`,
      data: { kind: 'workflow-dispatch', workflow: prepared.workflow, ref: prepared.refName, accepted: true },
    };
  },
});

for (const [action, suffix, verb] of [
  ['rerun', '/rerun', 'Requested a rerun of'],
  ['rerun_failed', '/rerun-failed-jobs', 'Requested a rerun of failed jobs in'],
  ['cancel', '/cancel', 'Cancelled'],
]) {
  defineOperation({
    tool: 'github_actions',
    action,
    risk: 'write',
    async prepare(ctx, args) {
      const id = Number(args.run_id);
      if (!Number.isInteger(id) || id <= 0) throw new GitHubError('run_id must be a positive integer.', { code: 'validation' });
      return { ref: repoFor(ctx, args), id, args };
    },
    async apply(ctx, prepared) {
      await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/actions/runs/${prepared.id}${suffix}`), {
        method: 'POST',
        signal: ctx.signal,
      });
      return {
        repo: prepared.ref.full,
        summary: `${verb} run ${prepared.id}`,
        data: { kind: 'run-action', action, run_id: prepared.id },
      };
    },
  });
}

defineOperation({
  tool: 'github_actions',
  action: 'logs',
  risk: 'read',
  async prepare(ctx, args) {
    const id = Number(args.run_id);
    if (!Number.isInteger(id) || id <= 0) throw new GitHubError('run_id must be a positive integer.', { code: 'validation' });
    return { ref: repoFor(ctx, args), id, args };
  },
  async apply(ctx, prepared) {
    if (typeof client(ctx).command !== 'function') {
      throw new GitHubError('Workflow logs need the gh command transport.', { code: 'unsupported' });
    }
    const args = ['run', 'view', String(prepared.id), '--repo', prepared.ref.full, '--log'];
    if (prepared.args.job_id !== undefined) args.push('--job', String(prepared.args.job_id));
    const result = await client(ctx).command(ctx.config, args, { signal: ctx.signal, maxStdoutBytes: 16 * 1024 * 1024 });
    const lines = Number.isInteger(prepared.args.tail) && prepared.args.tail > 0 ? prepared.args.tail : 200;
    return {
      repo: prepared.ref.full,
      summary: `Logs for run ${prepared.id}`,
      data: { kind: 'run-logs', run_id: prepared.id, text: tailLines(result.stdout, lines), truncated: result.stdout.split(/\r?\n/).length > lines },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'artifacts',
  risk: 'read',
  async prepare(ctx, args) {
    return { ref: repoFor(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const endpoint = prepared.args.run_id
      ? repoPath(prepared.ref, `/actions/runs/${Number(prepared.args.run_id)}/artifacts`)
      : repoPath(prepared.ref, '/actions/artifacts');
    const data = await client(ctx).apiJson(ctx.config, endpoint, { signal: ctx.signal });
    const items = Array.isArray(data?.artifacts)
      ? data.artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        size_in_bytes: artifact.size_in_bytes,
        expired: artifact.expired === true,
        created_at: artifact.created_at,
        archive_download_url: artifact.archive_download_url,
      }))
      : [];
    return {
      repo: prepared.ref.full,
      summary: `${items.length} artifact${items.length === 1 ? '' : 's'} in ${prepared.ref.full}`,
      data: { kind: 'artifact-list', items, total: data?.total_count ?? items.length, truncated: false },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'secrets_list',
  risk: 'read',
  async prepare(ctx, args) {
    return { ref: repoFor(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const data = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, '/actions/secrets'), { signal: ctx.signal });
    const items = Array.isArray(data?.secrets)
      ? data.secrets.map((secret) => ({ name: secret.name, created_at: secret.created_at, updated_at: secret.updated_at }))
      : [];
    return {
      repo: prepared.ref.full,
      summary: `${items.length} secret${items.length === 1 ? '' : 's'} in ${prepared.ref.full}`,
      data: { kind: 'secret-list', items, total: data?.total_count ?? items.length, truncated: false },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'secrets_set',
  risk: 'admin',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const name = String(args.name ?? '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new GitHubError('name must be a valid secret name.', { code: 'validation' });
    if (typeof client(ctx).command !== 'function') throw new GitHubError('Setting secrets needs the gh command transport.', { code: 'unsupported' });
    if (typeof args.value === 'string') {
      throw new GitHubError('Secret values must not be passed as tool arguments; use from_file or from_env.', {
        code: 'validation',
        hint: 'Write the value to a file inside the workspace or export it as an environment variable.',
      });
    }
    if (typeof args.from_file !== 'string' && typeof args.from_env !== 'string') {
      throw new GitHubError('secrets_set needs from_file or from_env.', { code: 'validation' });
    }
    return { ref, name, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Set secret ${prepared.name} on ${prepared.ref.full}`,
      effects: [`Create or replace secret ${prepared.name}`, 'The value is read from a file or environment variable and is never shown.'],
      confirm: `${prepared.ref.full}:${prepared.name}`,
    };
  },
  async apply(ctx, prepared) {
    const args = ['secret', 'set', prepared.name, '--repo', prepared.ref.full];
    if (prepared.args.environment) args.push('--env', String(prepared.args.environment));
    if (prepared.args.org) args.push('--org', String(prepared.args.org));
    const value = await secretValue(ctx, prepared.args);
    await client(ctx).command(ctx.config, args, { stdin: value, signal: ctx.signal });
    return {
      repo: prepared.ref.full,
      summary: `Set secret ${prepared.name} on ${prepared.ref.full}`,
      data: { kind: 'secret-set', name: prepared.name },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'secrets_delete',
  risk: 'admin',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const name = String(args.name ?? '').trim();
    if (name.length === 0) throw new GitHubError('name is required.', { code: 'validation' });
    return { ref, name, args };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Delete secret ${prepared.name} from ${prepared.ref.full}`,
      effects: [`Remove secret ${prepared.name}`],
      confirm: `${prepared.ref.full}:${prepared.name}`,
    };
  },
  async apply(ctx, prepared) {
    await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/actions/secrets/${encodeURIComponent(prepared.name)}`), {
      method: 'DELETE',
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Deleted secret ${prepared.name} from ${prepared.ref.full}`,
      data: { kind: 'secret-delete', name: prepared.name },
    };
  },
});

async function secretValue(ctx, args) {
  if (typeof args.value === 'string') {
    throw new GitHubError('Secret values must not be passed as tool arguments; use from_file or from_env.', {
      code: 'validation',
      hint: 'Write the value to a file inside the workspace or export it as an environment variable.',
    });
  }
  if (typeof args.from_env === 'string' && args.from_env.trim().length > 0) {
    const value = process.env[args.from_env.trim()];
    if (typeof value !== 'string') throw new GitHubError(`Environment variable ${args.from_env} is not set.`, { code: 'not_found' });
    return value;
  }
  if (typeof args.from_file === 'string' && args.from_file.trim().length > 0) {
    const base = ctx.session.cwd ?? process.cwd();
    const path = resolve(base, args.from_file.trim());
    if (!isInside(base, path)) throw new GitHubError('from_file must stay inside the session workspace.', { code: 'policy' });
    return readFile(path, 'utf8');
  }
  throw new GitHubError('secrets_set needs from_file or from_env.', { code: 'validation' });
}

defineOperation({
  tool: 'github_actions',
  action: 'variables_list',
  risk: 'read',
  async prepare(ctx, args) {
    return { ref: repoFor(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const data = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, '/actions/variables'), { signal: ctx.signal });
    const items = Array.isArray(data?.variables)
      ? data.variables.map((variable) => ({ name: variable.name, value: variable.value, updated_at: variable.updated_at }))
      : [];
    return {
      repo: prepared.ref.full,
      summary: `${items.length} variable${items.length === 1 ? '' : 's'} in ${prepared.ref.full}`,
      data: { kind: 'variable-list', items, total: data?.total_count ?? items.length, truncated: false },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'variables_set',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const name = String(args.name ?? '').trim();
    if (name.length === 0) throw new GitHubError('name is required.', { code: 'validation' });
    if (typeof args.value !== 'string') throw new GitHubError('value is required for a variable.', { code: 'validation' });
    return { ref, name, args };
  },
  async apply(ctx, prepared) {
    const endpoint = repoPath(prepared.ref, `/actions/variables/${encodeURIComponent(prepared.name)}`);
    try {
      await client(ctx).apiJson(ctx.config, endpoint, {
        method: 'PATCH',
        input: { name: prepared.name, value: prepared.args.value },
        signal: ctx.signal,
      });
    } catch (error) {
      if (error?.code !== 'not_found') throw error;
      await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, '/actions/variables'), {
        method: 'POST',
        input: { name: prepared.name, value: prepared.args.value },
        signal: ctx.signal,
      });
    }
    return {
      repo: prepared.ref.full,
      summary: `Set variable ${prepared.name} on ${prepared.ref.full}`,
      data: { kind: 'variable-set', name: prepared.name },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'variables_delete',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const name = String(args.name ?? '').trim();
    if (name.length === 0) throw new GitHubError('name is required.', { code: 'validation' });
    return { ref, name, args };
  },
  async apply(ctx, prepared) {
    await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, `/actions/variables/${encodeURIComponent(prepared.name)}`), {
      method: 'DELETE',
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Deleted variable ${prepared.name} from ${prepared.ref.full}`,
      data: { kind: 'variable-delete', name: prepared.name },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'caches_list',
  risk: 'read',
  async prepare(ctx, args) {
    return { ref: repoFor(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const data = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, '/actions/caches'), { signal: ctx.signal });
    const items = Array.isArray(data?.actions_caches)
      ? data.actions_caches.map((cache) => ({ id: cache.id, key: cache.key, size_in_bytes: cache.size_in_bytes, created_at: cache.created_at, last_accessed_at: cache.last_accessed_at }))
      : [];
    return {
      repo: prepared.ref.full,
      summary: `${items.length} cache${items.length === 1 ? '' : 's'} in ${prepared.ref.full}`,
      data: { kind: 'cache-list', items, total: data?.total_count ?? items.length, truncated: false },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'caches_delete',
  risk: 'write',
  async prepare(ctx, args) {
    const ref = repoFor(ctx, args);
    const id = Number(args.cache_id);
    const key = String(args.key ?? '').trim();
    if (!Number.isInteger(id) && key.length === 0) throw new GitHubError('cache_id or key is required.', { code: 'validation' });
    return { ref, id: Number.isInteger(id) ? id : null, key: key.length > 0 ? key : null, args };
  },
  async apply(ctx, prepared) {
    const suffix = prepared.id !== null ? `/actions/caches/${prepared.id}` : `/actions/caches?key=${encodeURIComponent(prepared.key)}`;
    await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, suffix), { method: 'DELETE', signal: ctx.signal });
    return {
      repo: prepared.ref.full,
      summary: `Deleted cache ${prepared.id ?? prepared.key} from ${prepared.ref.full}`,
      data: { kind: 'cache-delete', id: prepared.id, key: prepared.key },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'download_artifact',
  risk: 'local',
  async prepare(ctx, args) {
    const id = Number(args.run_id);
    if (!Number.isInteger(id) || id <= 0) throw new GitHubError('run_id must be a positive integer.', { code: 'validation' });
    if (typeof client(ctx).command !== 'function') throw new GitHubError('Artifact downloads need the gh command transport.', { code: 'unsupported' });
    return { ref: repoFor(ctx, args), id, args };
  },
  async apply(ctx, prepared) {
    const path = await import('node:path');
    const base = ctx.session.cwd ?? process.cwd();
    const dir = prepared.args.dir ? path.resolve(base, String(prepared.args.dir)) : base;
    if (!isInside(base, dir)) throw new GitHubError('dir must stay inside the session workspace.', { code: 'policy' });
    const args = ['run', 'download', String(prepared.id), '--repo', prepared.ref.full, '--dir', dir];
    if (prepared.args.name) args.push('--name', String(prepared.args.name));
    await client(ctx).command(ctx.config, args, { signal: ctx.signal });
    return {
      repo: prepared.ref.full,
      summary: `Downloaded artifacts for run ${prepared.id} to ${dir}`,
      data: { kind: 'artifact-download', run_id: prepared.id, dir },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'permissions_get',
  risk: 'read',
  async prepare(ctx, args) {
    return { ref: repoFor(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const data = await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, '/actions/permissions'), { signal: ctx.signal });
    return {
      repo: prepared.ref.full,
      summary: `Actions permissions for ${prepared.ref.full}`,
      data: { kind: 'actions-permissions', permissions: data },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'permissions_set',
  risk: 'admin',
  async prepare(ctx, args) {
    return { ref: repoFor(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const input = {};
    if (prepared.args.enabled !== undefined) input.enabled = prepared.args.enabled === true;
    if (prepared.args.allowed_actions !== undefined) input.allowed_actions = prepared.args.allowed_actions;
    if (Object.keys(input).length === 0) throw new GitHubError('permissions_set needs enabled or allowed_actions.', { code: 'validation' });
    await client(ctx).apiJson(ctx.config, repoPath(prepared.ref, '/actions/permissions'), {
      method: 'PUT',
      input,
      signal: ctx.signal,
    });
    return {
      repo: prepared.ref.full,
      summary: `Updated Actions permissions for ${prepared.ref.full}`,
      data: { kind: 'actions-permissions', changed: input },
    };
  },
});

defineOperation({
  tool: 'github_actions',
  action: 'runners_list',
  risk: 'read',
  async prepare(ctx, args) {
    return { ref: args.org ? null : repoFor(ctx, args), args };
  },
  async apply(ctx, prepared) {
    const endpoint = prepared.args.org
      ? `orgs/${encodeURIComponent(prepared.args.org)}/actions/runners`
      : repoPath(prepared.ref, '/actions/runners');
    const data = await client(ctx).apiJson(ctx.config, endpoint, { signal: ctx.signal });
    const items = Array.isArray(data?.runners)
      ? data.runners.map((runner) => ({ id: runner.id, name: runner.name, status: runner.status, busy: runner.busy, labels: runner.labels?.map((label) => label.name) ?? [] }))
      : [];
    return {
      repo: prepared.ref?.full ?? null,
      summary: `${items.length} runner${items.length === 1 ? '' : 's'}`,
      data: { kind: 'runner-list', items, total: data?.total_count ?? items.length, truncated: false },
    };
  },
});
