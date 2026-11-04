/**
 * Local git execution through the DSH subprocess and sandbox services.
 *
 * The plugin must not spawn git with raw pipes: local operations write into the
 * workspace and must obey the session's file policy, and long-lived git
 * children (filter-repo, fetch, clone) need the provider's managed process
 * range for termination.
 */

import { GitHubError, firstLine, redact } from '../errors.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
});

/**
 * Run one git command under the session's sandbox.
 *
 * @param {object} ctx - plugin context with `get(name)`.
 * @param {object} config - resolved plugin configuration.
 * @param {readonly string[]} args - git argv (without the executable).
 * @param {object} [options] - cwd, agent, signal, timeout, output caps, allowed exit codes.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export async function runGit(ctx, config, args, options = {}) {
  const getService = (name) => {
    try {
      return ctx?.get?.(name) ?? ctx?.session?.ctx?.get?.(name);
    } catch {
      return undefined;
    }
  };
  const subprocess = getService('subprocess');
  if (!subprocess) {
    throw new GitHubError('Local git operations need the DSH subprocess service.', {
      code: 'unsupported',
      hint: 'Mount @deepseek-ai/dsh-subprocess-local (or another subprocess provider) in this profile.',
    });
  }

  const timeoutMs = options.timeoutMs ?? config.longTimeoutMs ?? 900_000;
  const timeoutSignal = AbortSignal.timeout(Math.max(1_000, timeoutMs));
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const agent = options.agent;
  const sandboxPolicy = getService('sandboxPolicy');
  const sandbox = getService('sandbox');
  const policy = sandboxPolicy && agent ? sandboxPolicy.resolve({ session: agent.session }) : { mode: 'workspace-write' };

  let command;
  try {
    command = [await subprocess.resolveExecutable(config.gitPath ?? 'git', undefined, signal), ...args];
  } catch (error) {
    throw new GitHubError(`Could not resolve the git executable "${config.gitPath ?? 'git'}": ${error.message}`, {
      code: 'unsupported',
      cause: error,
    });
  }

  if (!sandbox && policy.mode !== 'danger-full-access') {
    throw new GitHubError('Local git writes need the DSH sandbox service.', {
      code: 'unsupported',
      hint: 'Mount @deepseek-ai/dsh-sandbox-local and @deepseek-ai/dsh-sandbox-policy in this profile.',
    });
  }

  const wrapped = policy.mode === 'danger-full-access' || !sandbox
    ? command
    : (await sandbox.confine(command, { ...policy, mode: policy.mode }, signal)).argv;

  const child = subprocess.spawn({
    argv: wrapped,
    cwd: options.cwd ?? process.cwd(),
    env: { ...GIT_ENV, ...(options.env ?? {}) },
    signal,
    graceMs: options.graceMs ?? 5_000,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES },
      stderr: { maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES },
    },
  });

  try {
    let outcome;
    try {
      outcome = await child.done;
    } catch (error) {
      if (error?.name === 'AbortError' || signal.aborted) {
        const reason = signal.reason;
        const code = reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
        throw new GitHubError(
          code === 'timeout' ? `git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s.` : 'The git operation was cancelled.',
          { code, cause: error },
        );
      }
      throw new GitHubError(`git ${args[0] ?? ''} failed: ${error.message}`, { code: 'git', cause: error });
    }

    const stdout = child.collected.stdout.readFrom(0);
    const stderr = child.collected.stderr.readFrom(0);
    const code = outcome.exitCode ?? -1;
    const allowed = options.allowCodes ?? [0];
    if (!allowed.includes(code)) {
      const detail = redact(`${stderr.text}\n${stdout.text}`.trim());
      throw new GitHubError(
        `git ${args[0] ?? ''} failed (${outcome.signal ?? code}): ${firstLine(detail) || 'no diagnostic'}`,
        {
          code: 'git',
          details: detail,
          hint: args[0] === 'push' ? 'Check the remote, branch protection, and `gh auth setup-git`.' : undefined,
        },
      );
    }
    if (stdout.lossy || stderr.lossy) {
      throw new GitHubError('The git command produced more output than this operation accepts.', {
        code: 'unsupported',
        hint: 'Narrow the request or raise the output limit.',
      });
    }
    return { code, stdout: stdout.text, stderr: stderr.text };
  } finally {
    child.terminate();
  }
}

/** Resolve a path through the filesystem service when available. */
export async function resolveWorkspacePath(ctx, input, base = process.cwd()) {
  const fs = ctx?.get?.('fs');
  if (fs && typeof fs.resolve === 'function') {
    const target = await fs.resolve(input, { cwd: base });
    return typeof fs.processPath === 'function' ? fs.processPath(target) : String(target);
  }
  const { resolve } = await import('node:path');
  return resolve(base, input);
}

/** True when `child` is inside `parent` (case-insensitive on Windows). */
export function isInside(parent, child) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const root = normalize(parent).replace(/[\\/]+$/, '');
  const target = normalize(child);
  return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`);
}
