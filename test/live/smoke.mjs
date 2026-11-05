/**
 * Minimal live probe for the plugin's installed code path.
 *
 * This is not part of the unit suite: it calls the real gh CLI and needs
 * network access plus a sandbox that allows child processes.
 */

import { spawn } from 'node:child_process';
import { apply, readStatus } from '../../index.js';
import { resolveConfig } from '../../lib/config.js';

const REPO = 'Unchpokable/clanker-playground';

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
      const stdout = [];
      const stderr = [];
      let outBytes = 0;
      let errBytes = 0;
      const maxOut = stdio?.stdout?.maxBytes ?? 48 * 1024 * 1024;
      const maxErr = stdio?.stderr?.maxBytes ?? 1024 * 1024;
      const done = new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          outBytes += chunk.length;
          if (outBytes <= maxOut) stdout.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
          errBytes += chunk.length;
          if (errBytes <= maxErr) stderr.push(chunk);
        });
        child.on('error', reject);
        child.on('close', (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
      });
      const onAbort = () => {
        try { child.kill(); } catch { /* already gone */ }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: Buffer.concat(stdout).toString('utf8'), lossy: outBytes > maxOut }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(stderr).toString('utf8'), lossy: errBytes > maxErr }) },
        },
        terminate() {
          signal?.removeEventListener('abort', onAbort);
          try { child.kill(); } catch { /* already gone */ }
        },
      };
    },
  };
}

function buildRuntime(config) {
  const tools = new Map();
  const requests = [];
  const approval = {
    async request(request) {
      requests.push(request);
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
  apply(ctx, config);
  const exec = { agent: { id: 'smoke' }, callId: 'smoke-1', signal: undefined };
  const call = async (name, args = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool ${name} is not registered`);
    const value = await tool.execute(args, exec);
    const rendered = tool.output?.render ? tool.output.render(args, value) : '';
    return { value, rendered };
  };
  return { tools, requests, approval, call };
}

async function main() {
  const config = resolveConfig({
    defaultRepo: REPO,
    defaultOwner: 'Unchpokable',
    requireApproval: true,
    allowDestructive: true,
    allowAdmin: true,
    allowGenericApi: 'write',
  });
  process.chdir(process.cwd());

  const runtime = buildRuntime(config);

  const status = await readStatus(config);
  console.log('STATUS', status.authenticated, status.account, status.host);

  const view = await runtime.call('github_repo', { action: 'view', repo: REPO });
  console.log('REPO VIEW', view.value.repo, view.value.data.repo.visibility);

  const created = await runtime.call('github_issue_create', {
    repo: REPO,
    title: `[plugin e2e] live probe ${new Date().toISOString()}`,
    body: 'Created by the dsh-github-cli live probe; safe to close.',
  });
  console.log('ISSUE CREATE', created.value.number, created.value.url);
  console.log('APPROVAL REQUESTS', runtime.requests.length);

  const closed = await runtime.call('github_issue', {
    action: 'close',
    repo: REPO,
    issue: String(created.value.number),
    state_reason: 'completed',
  });
  console.log('ISSUE CLOSE', closed.value.summary);

  console.log('OK');
}

main().catch((error) => {
  console.error('FAILED', error?.code ?? '', error?.message ?? error);
  if (error?.details) console.error(String(error.details).slice(0, 2000));
  process.exitCode = 1;
});
