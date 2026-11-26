import test from 'node:test';
import assert from 'node:assert/strict';
import { addPaymentWithinBalance, addRefundWithinPaidBalance, allocatePaise, applyIdempotently, applyStockChange, calculateSale, indianFinancialYear, parseRupeesToPaise, paymentStatus, paymentStatusAfterRefund, reconcileCash, splitByAmounts, transitionOrder } from '../src/lib/billing.ts';

test('rupee parsing uses integer paise and rejects precision loss', () => {
  assert.equal(parseRupeesToPaise('0'), 0);
  assert.equal(parseRupeesToPaise('1.2'), 120);
  assert.equal(parseRupeesToPaise('1.23'), 123);
  assert.throws(() => parseRupeesToPaise('1.001'), /two decimal places/);
  assert.throws(() => parseRupeesToPaise('-1'), /two decimal places/);
  assert.throws(() => parseRupeesToPaise('9007199254740992'), /supported range/);
});

test('Indian invoice financial year changes at midnight IST on 1 April', () => {
  assert.deepEqual(indianFinancialYear(new Date('2026-03-31T18:29:59.999Z')), { startYear: 2025, label: '2025-26' });
  assert.deepEqual(indianFinancialYear(new Date('2026-03-31T18:30:00.000Z')), { startYear: 2026, label: '2026-27' });
  assert.throws(() => indianFinancialYear(new Date(Number.NaN)), /valid date/);
});

test('order workflow rejects cancelled-order revival and out-of-order kitchen actions', () => {
  assert.deepEqual(transitionOrder('PREPARING', 'kot-ready'), { orderStatus: 'READY', kotStatus: 'READY' });
  assert.deepEqual(transitionOrder('READY', 'kot-served'), { orderStatus: 'SERVED', kotStatus: 'SERVED' });
  assert.deepEqual(transitionOrder('PREPARING', 'void'), { orderStatus: 'CANCELLED', kotStatus: 'CANCELLED' });
  assert.throws(() => transitionOrder('CANCELLED', 'kot-ready'), /Invalid order transition/);
  assert.throws(() => transitionOrder('PREPARING', 'kot-served'), /Invalid order transition/);
  assert.throws(() => transitionOrder('COMPLETED', 'void'), /cannot be cancelled/);
});

test('GST rounds per item in paise and preserves the taxable base', () => {
  const result = calculateSale([{ quantity: 2, unitPricePaise: 18000, gstBps: 500 }]);
  assert.deepEqual(result, { subtotalPaise: 36000, discountPaise: 0, taxablePaise: 36000, taxPaise: 1800, serviceChargePaise: 0, totalPaise: 37800 });
});

test('GST and service charge retain exact paise rounding near the safe-integer limit', () => {
  const result = calculateSale([{ quantity: 1, unitPricePaise: 8000000000000149, gstBps: 500 }], { serviceChargeBps: 500 });
  assert.deepEqual(result, {
    subtotalPaise: 8000000000000149,
    discountPaise: 0,
    taxablePaise: 8000000000000149,
    taxPaise: 400000000000007,
    serviceChargePaise: 400000000000007,
    totalPaise: 8800000000000163,
  });
});

test('discount is capped at subtotal; service charge is calculated on discounted amount', () => {
  const result = calculateSale([{ quantity: 1, unitPricePaise: 10001, gstBps: 500 }], { discountPaise: 20000, serviceChargeBps: 1000 });
  assert.deepEqual(result, { subtotalPaise: 10001, discountPaise: 10001, taxablePaise: 0, taxPaise: 0, serviceChargePaise: 0, totalPaise: 0 });
});

test('discount and service charge produce deterministic paise rounding', () => {
  const result = calculateSale([{ quantity: 1, unitPricePaise: 9999, gstBps: 500 }], { discountPaise: 1000, serviceChargeBps: 500 });
  assert.deepEqual(result, { subtotalPaise: 9999, discountPaise: 1000, taxablePaise: 8999, taxPaise: 450, serviceChargePaise: 450, totalPaise: 9899 });
});

test('line discounts and mixed GST rates preserve taxable totals', () => {
  assert.deepEqual(calculateSale([{ quantity: 1, unitPricePaise: 1000, gstBps: 500, discountPaise: 200 }]), { subtotalPaise: 1000, discountPaise: 200, taxablePaise: 800, taxPaise: 40, serviceChargePaise: 0, totalPaise: 840 });
  const mixed = calculateSale([{ quantity: 1, unitPricePaise: 10000, gstBps: 500 }, { quantity: 1, unitPricePaise: 10000, gstBps: 1200 }], { discountPaise: 1000 });
  assert.deepEqual(mixed, { subtotalPaise: 20000, discountPaise: 1000, taxablePaise: 19000, taxPaise: 1615, serviceChargePaise: 0, totalPaise: 20615 });
});

test('rejects empty, zero-quantity, negative and unsafe amount inputs', () => {
  assert.throws(() => calculateSale([]), /at least one item/);
  assert.throws(() => calculateSale([{ quantity: 0, unitPricePaise: 200 }]), /positive/);
  assert.throws(() => calculateSale([{ quantity: 1, unitPricePaise: -10 }]), /negative/);
  assert.throws(() => calculateSale([{ quantity: 1, unitPricePaise: Number.MAX_SAFE_INTEGER + 1 }]), /safe integer/);
  assert.throws(() => calculateSale([{ quantity: 1, unitPricePaise: 100 }], { discountPaise: -1 }), /negative/);
});

test('payment supports pending, partial, paid, and rejects negative amounts', () => {
  assert.equal(paymentStatus(1000, 0), 'PENDING');
  assert.equal(paymentStatus(1000, 400), 'PARTIAL');
  assert.equal(paymentStatus(1000, 1000), 'PAID');
  assert.throws(() => paymentStatus(1000, 1200), /exceed/);
  assert.throws(() => paymentStatus(1000, -1), /negative/);
});

test('payment recording cannot exceed the bill balance', () => {
  assert.equal(addPaymentWithinBalance(1000, 400, 600), 1000);
  assert.throws(() => addPaymentWithinBalance(1000, 400, 601), /outstanding bill balance/);
  assert.throws(() => addPaymentWithinBalance(1000, 1001, 1), /outstanding bill balance/);
  assert.throws(() => addPaymentWithinBalance(1000, 0, 0), /payment must be positive/);
  assert.throws(() => addPaymentWithinBalance(Number.MAX_SAFE_INTEGER + 1, 0, 1), /safe integer/);
});

test('refunds are bounded by captured funds and update net payment state', () => {
  assert.equal(addRefundWithinPaidBalance(1000, 0, 400), 400);
  assert.equal(addRefundWithinPaidBalance(1000, 400, 600), 1000);
  assert.throws(() => addRefundWithinPaidBalance(1000, 400, 601), /unrefunded payment balance/);
  assert.throws(() => addRefundWithinPaidBalance(1000, 1001, 1), /unrefunded payment balance/);
  assert.equal(paymentStatusAfterRefund(1000, 1000, 0), 'PAID');
  assert.equal(paymentStatusAfterRefund(1000, 1000, 400), 'PARTIAL');
  assert.equal(paymentStatusAfterRefund(1000, 1000, 1000), 'REFUNDED');
  assert.throws(() => paymentStatusAfterRefund(1000, 1000, 1001), /Invalid refunded payment balance/);
});

test('cash reconciliation accounts for opening float and reports over/short variance', () => {
  assert.deepEqual(reconcileCash(50000, [25000, 10000], 85000), { expectedCashPaise: 85000, countedCashPaise: 85000, variancePaise: 0 });
  assert.deepEqual(reconcileCash(50000, [25000, 10000], 80000, 5000), { expectedCashPaise: 80000, countedCashPaise: 80000, variancePaise: 0 });
  assert.equal(reconcileCash(50000, [25000], 74000).variancePaise, -1000);
});

test('stock deductions reject overselling and allow intentional offline negative stock', () => {
  assert.equal(applyStockChange(3000, -1000), 2000);
  assert.throws(() => applyStockChange(100, -101), /Insufficient stock/);
  assert.equal(applyStockChange(100, -101, true), -1);
});

test('offline sync retries return prior result without applying a mutation twice', () => {
  const applied = new Map(); let balance = 0;
  const mutation = { clientMutationId: 'device-1/order-9', payload: 250 };
  const handler = (amount) => { balance += amount; return balance; };
  assert.equal(applyIdempotently(mutation, applied, handler), 250);
  assert.equal(applyIdempotently(mutation, applied, handler), 250);
  assert.equal(balance, 250);
  assert.throws(() => applyIdempotently({ clientMutationId: ' ', payload: 1 }, applied, handler), /required/);
});

test('amount split must equal bill total exactly', () => {
  assert.deepEqual(splitByAmounts(10000, [4000, 6000]), [4000, 6000]);
  assert.throws(() => splitByAmounts(10000, [4000, 5999]), /add up/);
  assert.throws(() => splitByAmounts(10000, [10001, -1]), /negative/);
});

test('item split allocation distributes rounding paise deterministically and sums exactly', () => {
  assert.deepEqual(allocatePaise(10001n, [1n, 1n, 1n]), [3334n, 3334n, 3333n]);
  assert.deepEqual(allocatePaise(0n, [0n, 0n]), [0n, 0n]);
  assert.throws(() => allocatePaise(100n, [0n, 0n]), /positive total/);
});
