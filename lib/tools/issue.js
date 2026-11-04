/** `github_issue` — issue lifecycle, comments, labels, assignees, milestones. */

import { getOperation, listOperations, runOperation } from '../ops/registry.js';
import { renderValue } from '../render/common.js';
import '../ops/issue.js';

const REPO_PARAMETER = {
  type: 'string',
  description: 'Repository as "owner/name" or a GitHub URL. Defaults to the cwd binding, then defaultRepo.',
};

export function registerIssueTool(ctx, runtime) {
  const actions = listOperations('github_issue').map((operation) => operation.action);
  const { config } = runtime;

  ctx.tools.register({
    name: 'github_issue',
    description: `Manage GitHub issues. Actions: ${actions.join(', ')}. Create, update, close/reopen, comment, label, assign, set a milestone, lock, or transfer an issue. Writes ask for approval; github_issue_create remains a compatibility alias for create.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions, description: 'Operation to perform.' },
        repo: REPO_PARAMETER,
        issue: {
          type: 'string',
          description: 'Issue number or GitHub issue URL.',
        },
        number: {
          type: 'integer',
          description: 'Issue number alternative to issue.',
        },
        title: { type: 'string', description: 'Issue title for create/update.' },
        body: { type: 'string', description: 'Issue body or comment.' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels for create/update/list filter.',
        },
        assignees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Assignees for create/update.',
        },
        milestone: { type: 'integer', description: 'Milestone number.' },
        state: { type: 'string', description: 'State filter for list.' },
        state_reason: { type: 'string', enum: ['completed', 'not_planned', 'reopened'], description: 'Reason for close/reopen.' },
        add: { type: 'array', items: { type: 'string' }, description: 'Labels or assignees to add.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Labels or assignees to remove.' },
        set: { type: 'array', items: { type: 'string' }, description: 'Replace labels with this set.' },
        assignee: { type: 'string', description: 'Assignee filter for list.' },
        creator: { type: 'string', description: 'Creator filter for list.' },
        since: { type: 'string', description: 'ISO timestamp filter for list.' },
        include_pulls: { type: 'boolean', description: 'Include pull requests in the issue list.' },
        limit: { type: 'integer', description: 'Maximum items for list.' },
        new_repo: { type: 'string', description: 'Destination repository for transfer.' },
        reason: { type: 'string', description: 'Lock reason: off-topic, too heated, resolved, spam.' },
        dry_run: { type: 'boolean', description: 'Preview without writing.' },
        apply: { type: 'boolean', description: 'Apply a guarded plan.' },
        confirm: { type: 'string', description: 'Exact confirmation string from the plan.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    timeoutMs: config.timeoutMs + 5_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const operation = getOperation('github_issue', String(args.action ?? '').trim());
      return runOperation(operation, args, { ...runtime, exec });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `github_issue ${args.action ?? ''} ${args.issue ?? args.number ?? ''}`.trim(),
      kind: args.action === 'list' || args.action === 'view' ? 'read' : 'edit',
    }),
  });
}
