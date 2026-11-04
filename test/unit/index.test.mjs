import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, apply, name } from '../../index.js';

function fakeContext() {
  const tools = new Map();
  return {
    tools: {
      tools,
      register(definition) {
        tools.set(definition.name, definition);
      },
    },
    get() {
      return undefined;
    },
  };
}

test('plugin exports its name and config schema', () => {
  assert.equal(name, 'github-cli');
  assert.equal(typeof Config, 'function');
});

test('apply registers the compatibility and Phase 1 tools', () => {
  const ctx = fakeContext();
  apply(ctx, {});
  assert.deepEqual([...ctx.tools.tools.keys()].sort(), [
    'github_actions',
    'github_api',
    'github_diff',
    'github_extract',
    'github_file',
    'github_issue',
    'github_issue_create',
    'github_org',
    'github_pr',
    'github_pr_create',
    'github_read',
    'github_ref',
    'github_release',
    'github_repo',
    'github_review',
    'github_search',
    'github_status',
    'github_workspace',
  ]);
});

test('every registered tool has a description, parameters, output, and execute', () => {
  const ctx = fakeContext();
  apply(ctx, {});
  for (const [toolName, definition] of ctx.tools.tools) {
    assert.equal(typeof definition.description, 'string', `${toolName} description`);
    assert.equal(typeof definition.parameters, 'object', `${toolName} parameters`);
    assert.equal(typeof definition.output?.render, 'function', `${toolName} render`);
    assert.equal(typeof definition.execute, 'function', `${toolName} execute`);
  }
});

test('apply accepts the old config keys', () => {
  const ctx = fakeContext();
  apply(ctx, { ghPath: '', defaultRepo: 'owner/repo', maxOutputChars: 60_000, timeoutMs: 30_000, requireApproval: true });
  assert.equal(ctx.tools.tools.size, 18);
});

test('apply rejects an invalid config', () => {
  assert.throws(() => apply(fakeContext(), { maxOutputChars: 10 }), /maxOutputChars must be an integer/);
});
