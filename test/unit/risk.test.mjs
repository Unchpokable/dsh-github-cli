import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RISK,
  approvalPolicy,
  gateRisk,
  isGuarded,
  requiresApproval,
  riskAtLeast,
  riskRank,
} from '../../lib/risk.js';

test('risk ranks are ordered', () => {
  assert.ok(riskRank(RISK.read) < riskRank(RISK.write));
  assert.ok(riskRank(RISK.write) < riskRank(RISK.destructive));
  assert.ok(riskRank(RISK.destructive) < riskRank(RISK.admin));
  assert.equal(riskAtLeast(RISK.admin, RISK.destructive), true);
  assert.equal(isGuarded(RISK.write), false);
  assert.equal(isGuarded(RISK.destructive), true);
});

test('approvalPolicy normalizes booleans and objects', () => {
  assert.deepEqual(approvalPolicy(true), { write: true, destructive: true, admin: true });
  assert.deepEqual(approvalPolicy(false), { write: false, destructive: false, admin: false });
  assert.deepEqual(approvalPolicy({ write: false }), { write: false, destructive: true, admin: true });
  assert.deepEqual(approvalPolicy(undefined), { write: true, destructive: true, admin: true });
});

test('requiresApproval only applies to remote writes', () => {
  const config = { requireApproval: true };
  assert.equal(requiresApproval(config, RISK.read), false);
  assert.equal(requiresApproval(config, RISK.local), false);
  assert.equal(requiresApproval(config, RISK.write), true);
  assert.equal(requiresApproval({ requireApproval: { write: false } }, RISK.write), false);
  assert.equal(requiresApproval({ requireApproval: false }, RISK.admin), false);
});

test('gateRisk rejects destructive work when allowDestructive is false', () => {
  assert.throws(
    () => gateRisk({ risk: RISK.destructive, config: { allowDestructive: false }, args: { apply: true, confirm: 'x' }, plan: { confirm: 'x' } }),
    (error) => error.code === 'policy',
  );
});

test('gateRisk returns a plan when apply is missing', () => {
  const result = gateRisk({
    risk: RISK.destructive,
    config: { allowDestructive: true },
    args: {},
    plan: { confirm: 'owner/repo' },
  });
  assert.equal(result.planOnly, true);
});

test('gateRisk allows a plan even when destructive apply is disabled', () => {
  const result = gateRisk({
    risk: RISK.destructive,
    config: { allowDestructive: false },
    args: { dry_run: true },
    plan: { confirm: 'owner/repo' },
  });
  assert.equal(result.planOnly, true);
});

test('gateRisk requires a matching confirm string', () => {
  const base = {
    risk: RISK.destructive,
    config: { allowDestructive: true },
    plan: { confirm: 'owner/repo -> new-owner' },
  };
  assert.throws(() => gateRisk({ ...base, args: { apply: true } }), (error) => error.code === 'validation');
  assert.throws(() => gateRisk({ ...base, args: { apply: true, confirm: 'wrong' } }), (error) => error.code === 'validation');
  assert.deepEqual(gateRisk({ ...base, args: { apply: true, confirm: 'owner/repo -> new-owner' } }), { planOnly: false, reason: '' });
});

test('gateRisk rejects admin work without allowAdmin', () => {
  assert.throws(
    () => gateRisk({ risk: RISK.admin, config: { allowDestructive: true, allowAdmin: false }, args: { apply: true }, plan: { confirm: 'x' } }),
    (error) => error.code === 'policy',
  );
});

test('gateRisk lets read and write pass', () => {
  assert.equal(gateRisk({ risk: RISK.read, config: {}, args: {} }).planOnly, false);
  assert.equal(gateRisk({ risk: RISK.write, config: {}, args: {} }).planOnly, false);
  assert.equal(gateRisk({ risk: RISK.write, config: {}, args: { dry_run: true } }).planOnly, true);
});
