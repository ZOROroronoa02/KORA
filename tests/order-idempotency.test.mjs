import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderRequestHash } from '../src/lib/order-idempotency.ts';

const base = {
  outletId: 'outlet-1', deviceId: 'device-1', type: 'TAKEAWAY',
  items: [{ menuItemId: 'item-1', quantity: 1, note: null }],
  paidPaise: 0, discountBps: 0, paymentMethod: null, customerId: null, tableId: null,
  buyerDetails: { name: 'Aarav', address: { state: 'Karnataka', city: 'Bengaluru' } }, kitchenNote: null,
};

test('order idempotency hashes are stable across JSON object key order', () => {
  const reordered = { ...base, buyerDetails: { address: { city: 'Bengaluru', state: 'Karnataka' }, name: 'Aarav' } };
  assert.equal(createOrderRequestHash(base), createOrderRequestHash(reordered));
});

test('order idempotency hashes bind outlet, device, items, payment, and buyer data', () => {
  const expected = createOrderRequestHash(base);
  for (const change of [
    { outletId: 'outlet-2' },
    { deviceId: 'device-2' },
    { items: [{ menuItemId: 'item-1', quantity: 2, note: null }] },
    { paidPaise: 100 },
    { buyerDetails: { name: 'Different guest' } },
  ]) {
    assert.notEqual(createOrderRequestHash({ ...base, ...change }), expected);
  }
});
