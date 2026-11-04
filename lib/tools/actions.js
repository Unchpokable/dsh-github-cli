/** `github_actions` — GitHub Actions workflows, runs, logs, secrets, variables. */

import { getOperation, listOperations, runOperation } from '../ops/registry.js';
import { renderValue } from '../render/common.js';
import '../ops/actions.js';

const REPO_PARAMETER = {
  type: 'string',
  description: 'Repository as "owner/name" or a GitHub URL. Defaults to the cwd binding, then defaultRepo.',
};

export function registerActionsTool(ctx, runtime) {
  const actions = listOperations('github_actions').map((operation) => operation.action);
  const { config } = runtime;

  ctx.tools.register({
    name: 'github_actions',
    description: `Inspect and control GitHub Actions. Actions: ${actions.join(', ')}. Dispatch a workflow, list runs, read jobs and logs, rerun/cancel, list artifacts/secrets/variables/caches. Setting or deleting secrets is admin-risk and requires apply, confirm, and allowAdmin; secret values come from from_file or from_env, never from an argument.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions, description: 'Operation to perform.' },
        repo: REPO_PARAMETER,
        workflow: { type: 'string', description: 'Workflow id, file name, or path.' },
        workflow_id: { type: 'integer', description: 'Workflow id filter for runs.' },
        run_id: { type: 'integer', description: 'Workflow run id.' },
        ref: { type: 'string', description: 'Git ref for dispatch.' },
        inputs: { type: 'object', description: 'Workflow dispatch inputs.' },
        branch: { type: 'string', description: 'Branch filter for runs.' },
        status: { type: 'string', description: 'Status filter for runs.' },
        event: { type: 'string', description: 'Event filter for runs.' },
        actor: { type: 'string', description: 'Actor filter for runs.' },
        limit: { type: 'integer', description: 'Maximum runs to return.' },
        include_jobs: { type: 'boolean', description: 'Include jobs in run view.' },
        job_id: { type: 'integer', description: 'Job id for logs.' },
        tail: { type: 'integer', description: 'Number of log lines to return; defaults to 200.' },
        name: { type: 'string', description: 'Secret or variable name.' },
        from_file: { type: 'string', description: 'Read a secret value from this workspace file.' },
        from_env: { type: 'string', description: 'Read a secret value from this environment variable.' },
        environment: { type: 'string', description: 'Environment name for a secret.' },
        value: { type: 'string', description: 'Variable value (not for secrets).' },
        cache_id: { type: 'integer', description: 'Cache id to delete.' },
        key: { type: 'string', description: 'Cache key to delete.' },
        dir: { type: 'string', description: 'Workspace directory for artifact download.' },
        enabled: { type: 'boolean', description: 'Enable Actions for the repository.' },
        allowed_actions: { type: 'string', description: 'Allowed actions policy.' },
        org: { type: 'string', description: 'Organization for org-level runners or secrets.' },
        dry_run: { type: 'boolean', description: 'Preview without writing.' },
        apply: { type: 'boolean', description: 'Apply a guarded plan.' },
        confirm: { type: 'string', description: 'Exact confirmation string from the plan.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{
        type: 'text',
        text: value?.data?.kind === 'run-logs' ? value.data.text : renderValue(value),
      }],
    },
    timeoutMs: config.timeoutMs + 5_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const operation = getOperation('github_actions', String(args.action ?? '').trim());
      return runOperation(operation, args, { ...runtime, exec });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `github_actions ${args.action ?? ''} ${args.workflow ?? args.run_id ?? ''}`.trim(),
      kind: args.action?.startsWith('logs') || args.action?.endsWith('_list') ? 'read' : 'edit',
    }),
  });
}
