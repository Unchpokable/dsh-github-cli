/**
 * Plugin configuration: defaults, validation, and the DSH-facing schema.
 *
 * The old keys keep their names, defaults, and error messages. New keys are
 * additive and optional, so an existing profile keeps working unchanged.
 */

import z from '@deepseek-ai/schemastery';

/** Defaults for every supported key. */
export const DEFAULTS = Object.freeze({
  ghPath: '',
  gitPath: 'git',
  defaultHost: 'github.com',
  defaultRepo: '',
  defaultOwner: '',
  defaultOrg: '',
  workspaceRoot: '',
  scratchDir: '.dsh/github',
  maxOutputChars: 80_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxWriteBytes: 5 * 1024 * 1024,
  maxPages: 10,
  timeoutMs: 60_000,
  longTimeoutMs: 900_000,
  requireApproval: true,
  allowDestructive: false,
  allowAdmin: false,
  allowGenericApi: 'read',
  protectedBranches: ['main', 'master'],
  allowedOrgs: [],
  deniedOrgs: [],
  dryRunDestructive: true,
  extraction: Object.freeze({
    history: 'preserve',
    filterRepoPath: '',
    allowHistoryRewrite: true,
    cleanupOnFailure: true,
    scratchTtlMs: 3_600_000,
  }),
  actions: Object.freeze({
    allowSecrets: true,
    allowRunnerTokens: false,
    maxLogLines: 200,
  }),
});

const APPROVAL_SCHEMA = z.union([
  z.boolean(),
  z.object({
    write: z.boolean().default(true),
    destructive: z.boolean().default(true),
    admin: z.boolean().default(true),
  }),
]);

/**
 * Configuration schema shown by the DSH settings form.
 *
 * DSH reads this export to generate a form and to validate a row's config. The
 * runtime still calls {@link resolveConfig} so the plugin keeps its own error
 * messages and nested defaults.
 */
export const Config = z.object({
  ghPath: z.string().default('').description('Absolute path to the gh executable. Empty means discover it.'),
  gitPath: z.string().default('git').description('Git executable used for local clones, commits, and extraction.'),
  defaultHost: z.string().default('github.com').description('GitHub host used when a repository does not name one.'),
  defaultRepo: z.string().default('').description('Repository used when a tool call omits repo, e.g. owner/name.'),
  defaultOwner: z.string().default('').description('Default owner for repository creation.'),
  defaultOrg: z.string().default('').description('Default organization for creation and organization operations.'),
  workspaceRoot: z.string().default('').description('Root for clones. Empty uses the session working directory.'),
  scratchDir: z.string().default('.dsh/github').description('Directory for temporary clones, logs, and downloads.'),
  maxOutputChars: z.number().min(2_000).max(2_000_000).default(80_000).description('Per-call text returned to the model.'),
  maxFileBytes: z.number().min(1_024).max(104_857_600).default(2 * 1024 * 1024).description('Maximum file size read into the model.'),
  maxWriteBytes: z.number().min(1_024).max(104_857_600).default(5 * 1024 * 1024).description('Maximum content written by one file operation.'),
  maxPages: z.number().min(1).max(100).default(10).description('Maximum REST pages fetched by one list operation.'),
  timeoutMs: z.number().min(5_000).max(600_000).default(60_000).description('Timeout for one ordinary gh call.'),
  longTimeoutMs: z.number().min(10_000).max(3_600_000).default(900_000).description('Timeout for clone, extraction, and downloads.'),
  requireApproval: APPROVAL_SCHEMA.default(true).description('Ask the session approval channel before remote writes.'),
  allowDestructive: z.boolean().default(false).description('Allow destructive operations after a matching confirm string.'),
  allowAdmin: z.boolean().default(false).description('Allow organization and security administration operations.'),
  allowGenericApi: z.union([z.const('read'), z.const('write'), z.const(false)]).default('read').description('Capability of the generic github_api tool.'),
  protectedBranches: z.array(z.string()).default(['main', 'master']).description('Branches that reject direct commits by default.'),
  allowedOrgs: z.array(z.string()).default([]).description('Organization allowlist. Empty allows every organization.'),
  deniedOrgs: z.array(z.string()).default([]).description('Organization denylist.'),
  dryRunDestructive: z.boolean().default(true).description('Return a plan for destructive operations unless apply is true.'),
  extraction: z.object({
    history: z.union([z.const('preserve'), z.const('snapshot')]).default('preserve').description('Default extraction history mode.'),
    filterRepoPath: z.string().default('').description('Path to git-filter-repo. Empty discovers it on PATH.'),
    allowHistoryRewrite: z.boolean().default(false).description('Allow strategies that rewrite history in a temporary clone.'),
    cleanupOnFailure: z.boolean().default(true).description('Delete a destination repository created by a failed extraction.'),
    scratchTtlMs: z.number().min(60_000).max(86_400_000).default(3_600_000).description('Age after which an unused scratch directory may be pruned.'),
  }).default({
    history: 'preserve',
    filterRepoPath: '',
    allowHistoryRewrite: true,
    cleanupOnFailure: true,
    scratchTtlMs: 3_600_000,
  }),
  actions: z.object({
    allowSecrets: z.boolean().default(true).description('Allow setting repository, organization, and environment secrets.'),
    allowRunnerTokens: z.boolean().default(false).description('Allow reading runner registration tokens.'),
    maxLogLines: z.number().min(10).max(5_000).default(200).description('Default tail length for workflow logs.'),
  }).default({
    allowSecrets: true,
    allowRunnerTokens: false,
    maxLogLines: 200,
  }),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value, key) {
  if (typeof value !== 'string') throw new Error(`github-cli: ${key} must be a string.`);
}

function assertBoolean(value, key) {
  if (typeof value !== 'boolean') throw new Error(`github-cli: ${key} must be a boolean.`);
}

function assertInteger(value, key, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`github-cli: ${key} must be an integer between ${min} and ${max}.`);
  }
}

function assertStringArray(value, key) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`github-cli: ${key} must be an array of strings.`);
  }
}

function normalizedApproval(value) {
  if (value === true || value === false) return value;
  if (!isPlainObject(value)) {
    throw new Error('github-cli: requireApproval must be a boolean or an object with write/destructive/admin booleans.');
  }
  for (const key of ['write', 'destructive', 'admin']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(`github-cli: requireApproval.${key} must be a boolean.`);
    }
  }
  return {
    write: value.write !== false,
    destructive: value.destructive !== false,
    admin: value.admin !== false,
  };
}

/**
 * Validate a row config and fill every default.
 *
 * @param {unknown} raw - row config from the patch layer.
 * @returns {typeof DEFAULTS & { extraction: object, actions: object }} resolved config.
 */
export function resolveConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const config = { ...DEFAULTS, ...source };

  assertString(config.ghPath, 'ghPath');
  assertString(config.gitPath, 'gitPath');
  assertString(config.defaultHost, 'defaultHost');
  assertString(config.defaultRepo, 'defaultRepo');
  assertString(config.defaultOwner, 'defaultOwner');
  assertString(config.defaultOrg, 'defaultOrg');
  assertString(config.workspaceRoot, 'workspaceRoot');
  assertString(config.scratchDir, 'scratchDir');

  if (config.defaultHost.trim().length === 0) throw new Error('github-cli: defaultHost must not be empty.');
  if (config.gitPath.trim().length === 0) throw new Error('github-cli: gitPath must not be empty.');
  if (config.scratchDir.trim().length === 0) throw new Error('github-cli: scratchDir must not be empty.');

  assertInteger(config.maxOutputChars, 'maxOutputChars', 2_000, 2_000_000);
  assertInteger(config.maxFileBytes, 'maxFileBytes', 1_024, 104_857_600);
  assertInteger(config.maxWriteBytes, 'maxWriteBytes', 1_024, 104_857_600);
  assertInteger(config.maxPages, 'maxPages', 1, 100);
  assertInteger(config.timeoutMs, 'timeoutMs', 5_000, 600_000);
  assertInteger(config.longTimeoutMs, 'longTimeoutMs', 10_000, 3_600_000);
  if (config.longTimeoutMs < config.timeoutMs) {
    throw new Error('github-cli: longTimeoutMs must be greater than or equal to timeoutMs.');
  }

  assertBoolean(config.allowDestructive, 'allowDestructive');
  assertBoolean(config.allowAdmin, 'allowAdmin');
  assertBoolean(config.dryRunDestructive, 'dryRunDestructive');

  if (config.allowGenericApi !== 'read' && config.allowGenericApi !== 'write' && config.allowGenericApi !== false) {
    throw new Error('github-cli: allowGenericApi must be "read", "write", or false.');
  }

  assertStringArray(config.protectedBranches, 'protectedBranches');
  assertStringArray(config.allowedOrgs, 'allowedOrgs');
  assertStringArray(config.deniedOrgs, 'deniedOrgs');
  config.protectedBranches = [...new Set(config.protectedBranches.map((branch) => branch.trim()).filter(Boolean))];
  config.allowedOrgs = [...new Set(config.allowedOrgs.map((org) => org.trim()).filter(Boolean))];
  config.deniedOrgs = [...new Set(config.deniedOrgs.map((org) => org.trim()).filter(Boolean))];
  const overlap = config.allowedOrgs.filter((org) => config.deniedOrgs.includes(org));
  if (overlap.length > 0) {
    throw new Error(`github-cli: organization "${overlap[0]}" is both allowed and denied.`);
  }

  config.requireApproval = normalizedApproval(config.requireApproval);

  if (!isPlainObject(config.extraction)) {
    throw new Error('github-cli: extraction must be an object.');
  }
  config.extraction = { ...DEFAULTS.extraction, ...config.extraction };
  if (config.extraction.history !== 'preserve' && config.extraction.history !== 'snapshot') {
    throw new Error('github-cli: extraction.history must be "preserve" or "snapshot".');
  }
  assertString(config.extraction.filterRepoPath, 'extraction.filterRepoPath');
  assertBoolean(config.extraction.allowHistoryRewrite, 'extraction.allowHistoryRewrite');
  assertBoolean(config.extraction.cleanupOnFailure, 'extraction.cleanupOnFailure');
  assertInteger(config.extraction.scratchTtlMs, 'extraction.scratchTtlMs', 60_000, 86_400_000);

  if (!isPlainObject(config.actions)) {
    throw new Error('github-cli: actions must be an object.');
  }
  config.actions = { ...DEFAULTS.actions, ...config.actions };
  assertBoolean(config.actions.allowSecrets, 'actions.allowSecrets');
  assertBoolean(config.actions.allowRunnerTokens, 'actions.allowRunnerTokens');
  assertInteger(config.actions.maxLogLines, 'actions.maxLogLines', 10, 5_000);

  return config;
}
