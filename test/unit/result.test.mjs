import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countLabel,
  isPlan,
  nextStep,
  planResult,
  renderDefault,
  stripAnsi,
  success,
  tailLines,
  toolText,
  truncateText,
} from '../../lib/result.js';

test('success builds an applied envelope', () => {
  const value = success({
    operation: 'repo.create',
    repo: 'owner/repo',
    summary: 'created',
    data: { private: true },
    warnings: ['one'],
    next: [nextStep('github_workspace', { action: 'clone' }, 'clone')],
    journalId: 'op_1',
  });
  assert.equal(value.ok, true);
  assert.equal(value.applied, true);
  assert.equal(value.plan, null);
  assert.equal(value.journal_id, 'op_1');
  assert.equal(value.next[0].tool, 'github_workspace');
});

test('planResult builds a non-applied envelope', () => {
  const value = planResult({
    operation: 'repo.transfer',
    plan: { id: 'p1', risk: 'destructive', summary: 'transfer', warnings: ['w'], confirm: 'x' },
  });
  assert.equal(value.applied, false);
  assert.equal(value.plan.id, 'p1');
  assert.deepEqual(value.warnings, ['w']);
  assert.equal(isPlan(value), true);
});

test('text helpers bound output', () => {
  assert.equal(truncateText('abcdef', 3), 'abc\n[...]');
  assert.equal(truncateText('abc', 3), 'abc');
  assert.equal(tailLines('a\nb\nc', 2).split('\n')[0], 'b');
  assert.equal(tailLines('a\nb\nc', 2).split('\n').at(-1), '[... 1 earlier lines omitted]');
  assert.equal(stripAnsi('\u001B[31mred\u001B[0m'), 'red');
  assert.equal(countLabel(1, 'file'), '1 file');
  assert.equal(countLabel(2, 'file'), '2 files');
  assert.deepEqual(toolText('hi'), [{ type: 'text', text: 'hi' }]);
});

test('renderDefault prefers summary and avoids raw dumps', () => {
  assert.equal(renderDefault({ summary: 'done', url: 'https://example.test' }), 'done\nhttps://example.test');
  assert.equal(renderDefault('plain'), 'plain');
  assert.equal(renderDefault(null), 'ok');
});
