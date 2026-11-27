import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresDiscountApproval, settingsForOutlet, stockShortagePolicyForOutlet } from '../src/lib/domain/discount-approval.ts';

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

test('outlet recipe stock policy defaults to block and only allows explicit negative stock', () => {
  assert.equal(stockShortagePolicyForOutlet(null), 'BLOCK');
  assert.equal(stockShortagePolicyForOutlet({ stockShortagePolicy: 'BLOCK' }), 'BLOCK');
  assert.equal(stockShortagePolicyForOutlet({ stockShortagePolicy: 'ALLOW_NEGATIVE' }), 'ALLOW_NEGATIVE');
  assert.equal(stockShortagePolicyForOutlet({ stockShortagePolicy: 'ignore' }), 'BLOCK');
});
