/**
 * Workspace operations: bind, clone, checkout, sync, status, and worktrees.
 *
 * Risk is `local`: these operations write only inside the workspace and are
 * governed by the session's file policy, not by the GitHub approval channel.
 */

import { defineOperation } from './registry.js';
import { bindWorkspace, checkout, cloneRepository, listWorkspaces, sync, unbindWorkspace, workspaceStatus } from '../git/local.js';

defineOperation({
  tool: 'github_workspace',
  action: 'status',
  risk: 'read',
  async apply(ctx, prepared) {
    const value = await workspaceStatus(ctx, ctx.config, prepared.args);
    return {
      repo: value.repo,
      summary: `${value.path}: ${value.branch ?? 'detached'}${value.dirty > 0 ? `, ${value.dirty} changed` : ', clean'}`,
      data: { kind: 'workspace-status', ...value },
    };
  },
  async prepare(ctx, args) {
    return { args };
  },
});

defineOperation({
  tool: 'github_workspace',
  action: 'list',
  risk: 'read',
  async apply(ctx) {
    const items = listWorkspaces(ctx).map((binding) => ({
      repo: binding.repo,
      path: binding.path,
      branch: binding.branch,
      remote: binding.remote,
    }));
    return {
      summary: `${items.length} workspace binding${items.length === 1 ? '' : 's'}`,
      data: { kind: 'workspace-list', items, total: items.length, truncated: false },
    };
  },
});

defineOperation({
  tool: 'github_workspace',
  action: 'bind',
  risk: 'local',
  async apply(ctx, prepared) {
    const binding = await bindWorkspace(ctx, ctx.config, prepared.args);
    return {
      repo: binding.repo,
      summary: `Bound ${binding.path} to ${binding.repo}`,
      data: { kind: 'workspace-binding', ...binding },
    };
  },
  async prepare(ctx, args) {
    return { args };
  },
});

defineOperation({
  tool: 'github_workspace',
  action: 'unbind',
  risk: 'local',
  async apply(ctx, prepared) {
    const result = unbindWorkspace(ctx, prepared.args);
    return {
      summary: result.removed ? `Unbound ${result.path}` : `${result.path} was not bound`,
      data: { kind: 'workspace-unbind', ...result },
    };
  },
  async prepare(ctx, args) {
    return { args };
  },
});

defineOperation({
  tool: 'github_workspace',
  action: 'clone',
  risk: 'local',
  async prepare(ctx, args) {
    const ref = ctx.session.resolveRepo(args.repo, { cwd: ctx.session.cwd });
    const destination = args.path ?? `${ref.owner}/${ref.name}`;
    return { args, ref, destination };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Clone ${prepared.ref.full} into ${prepared.destination}`,
      effects: [`Fetch ${prepared.ref.full}`, `Create a checkout at ${prepared.destination}`],
      warnings: prepared.args.depth ? [`Shallow clone (depth ${prepared.args.depth}); history is incomplete.`] : [],
    };
  },
  async apply(ctx, prepared) {
    const result = await cloneRepository(ctx, ctx.config, prepared.args);
    return {
      repo: result.repo,
      summary: `Cloned ${result.repo} into ${result.path}`,
      data: { kind: 'workspace-clone', ...result },
    };
  },
});

defineOperation({
  tool: 'github_workspace',
  action: 'checkout',
  risk: 'local',
  async prepare(ctx, args) {
    if (args.ref === undefined && args.pr === undefined && args.branch === undefined) {
      throw new Error('ref, branch, or pr is required for checkout.');
    }
    return { args };
  },
  async plan(ctx, prepared) {
    const target = prepared.args.pr !== undefined ? `PR ${prepared.args.pr}` : (prepared.args.ref ?? prepared.args.branch);
    return {
      summary: `Checkout ${target}`,
      effects: [`Change the working tree to ${target}`],
    };
  },
  async apply(ctx, prepared) {
    const result = await checkout(ctx, ctx.config, prepared.args);
    return {
      summary: `Checked out ${result.ref} in ${result.path}`,
      data: { kind: 'workspace-checkout', ...result },
    };
  },
});

defineOperation({
  tool: 'github_workspace',
  action: 'sync',
  risk: 'local',
  async apply(ctx, prepared) {
    const result = await sync(ctx, ctx.config, prepared.args);
    return {
      summary: `Synced ${result.path} (${result.mode})`,
      data: { kind: 'workspace-sync', ...result },
    };
  },
  async prepare(ctx, args) {
    return { args };
  },
});

defineOperation({
  tool: 'github_workspace',
  action: 'worktree',
  risk: 'local',
  async prepare(ctx, args) {
    const ref = String(args.from ?? args.ref ?? 'HEAD').trim();
    if (ref.length === 0) throw new Error('from is required for a worktree.');
    return { args: { ...args, ref, worktree: true } };
  },
  async plan(ctx, prepared) {
    return {
      summary: `Create a worktree from ${prepared.args.ref}`,
      effects: ['Create a new branch and checkout', 'Keep the source worktree untouched'],
    };
  },
  async apply(ctx, prepared) {
    const result = await checkout(ctx, ctx.config, prepared.args);
    return {
      summary: `Created worktree ${result.path}`,
      data: { kind: 'workspace-worktree', ...result },
    };
  },
});
