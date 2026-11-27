import test from 'node:test';
import assert from 'node:assert/strict';
import { movingWeightedAverageUnitCostPaise, nextStockQuantity, purchaseLineTotalPaise, purchaseTotalPaise } from '../src/lib/domain/inventory-costing.ts';

test('purchase line totals use integer milli-units, paise, and half-up rounding', () => {
  assert.equal(purchaseLineTotalPaise(1_000n, 12_345n), 12_345n);
  assert.equal(purchaseLineTotalPaise(1n, 500n), 1n);
  assert.equal(purchaseLineTotalPaise(499n, 1n), 0n);
  assert.equal(purchaseTotalPaise([{ quantityMilli: 1_500n, unitCostPaise: 8_000n }, { quantityMilli: 500n, unitCostPaise: 10_000n }]), 17_000n);
});

test('weighted average cost blends only positive existing stock with landed receipt cost', () => {
  assert.equal(movingWeightedAverageUnitCostPaise({ quantityBeforeMilli: 2_500n, unitCostBeforePaise: 8_000n, quantityReceivedMilli: 1_000n, landedUnitCostPaise: 10_000n }), 8_571n);
  assert.equal(movingWeightedAverageUnitCostPaise({ quantityBeforeMilli: 0n, unitCostBeforePaise: 8_000n, quantityReceivedMilli: 1_000n, landedUnitCostPaise: 10_000n }), 10_000n);
  assert.equal(movingWeightedAverageUnitCostPaise({ quantityBeforeMilli: -500n, unitCostBeforePaise: 8_000n, quantityReceivedMilli: 1_000n, landedUnitCostPaise: 10_000n }), 10_000n, 'negative shortage stock contributes no fictitious value');
});

test('purchase costing rejects invalid quantities, costs, line counts, and paise overflow', () => {
  assert.throws(() => purchaseLineTotalPaise(0n, 1n), RangeError);
  assert.throws(() => purchaseLineTotalPaise(1n, -1n), RangeError);
  assert.throws(() => purchaseLineTotalPaise(9_223_372_036_854_775_807n, 9_223_372_036_854_775_807n), RangeError);
  assert.throws(() => purchaseTotalPaise([]), RangeError);
  assert.throws(() => nextStockQuantity(9_223_372_036_854_775_807n, 1n), RangeError);
});
