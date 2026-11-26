import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresDiscountApproval, settingsForOutlet } from '../src/lib/domain/discount-approval.ts';

test('discount approval is only required above the outlet threshold', () => {
  const policy = { discountApprovalThresholdPct: 10 };
  assert.equal(requiresDiscountApproval(0, policy), false);
  assert.equal(requiresDiscountApproval(1000, policy), false);
  assert.equal(requiresDiscountApproval(1001, policy), true);
});

test('discount approval rejects invalid rates and settings fail safely to defaults', () => {
  assert.throws(() => requiresDiscountApproval(-1, {}), /integer/);
  assert.throws(() => requiresDiscountApproval(10001, {}), /integer/);
  assert.throws(() => requiresDiscountApproval(100, { discountApprovalThresholdPct: 101 }), /threshold/);
  assert.deepEqual(settingsForOutlet(null), {});
  assert.deepEqual(settingsForOutlet({ discountApprovalThresholdPct: 101 }), { discountApprovalThresholdPct: 10 });
});
