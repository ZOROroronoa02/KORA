import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateKdsTicketState, nextKdsItemState, slaBand, slaElapsedSeconds, validateHoldReason } from '../src/lib/domain/kds.ts';
import { buildEscPosKot } from '../src/lib/domain/escpos-kot.ts';

test('KDS item transitions advance once and stop at final states', () => {
  assert.equal(nextKdsItemState('QUEUED'), 'COOKING');
  assert.equal(nextKdsItemState('COOKING'), 'READY');
  assert.equal(nextKdsItemState('READY'), 'BUMPED');
  assert.equal(nextKdsItemState('BUMPED'), null);
  assert.equal(nextKdsItemState('OUT_OF_STOCK'), null);
});

test('KDS ticket aggregate ignores 86 items but requires remaining items to be ready', () => {
  assert.equal(aggregateKdsTicketState(['QUEUED', 'OUT_OF_STOCK']), 'QUEUED');
  assert.equal(aggregateKdsTicketState(['COOKING', 'OUT_OF_STOCK']), 'PREPARING');
  assert.equal(aggregateKdsTicketState(['READY', 'OUT_OF_STOCK']), 'READY');
  assert.equal(aggregateKdsTicketState(['BUMPED', 'OUT_OF_STOCK']), 'SERVED');
  assert.equal(aggregateKdsTicketState(['OUT_OF_STOCK']), 'CANCELLED');
});

test('SLA clock excludes paused time and classifies target bands', () => {
  const createdAt = '2026-11-26T10:00:00.000Z';
  const now = '2026-11-26T10:20:00.000Z';
  assert.equal(slaElapsedSeconds({ createdAt, now, holdDurationSeconds: 300 }), 900);
  assert.equal(slaElapsedSeconds({ createdAt, now, heldAt: '2026-11-26T10:15:00.000Z' }), 900);
  assert.equal(slaBand(599, 10), 'green');
  assert.equal(slaBand(600, 10), 'green');
  assert.equal(slaBand(601, 10), 'amber');
  assert.equal(slaBand(900, 10), 'amber');
  assert.equal(slaBand(901, 10), 'red');
});

test('hold reasons are bounded and require useful text', () => {
  assert.equal(validateHoldReason('  waiting for guest  '), 'waiting for guest');
  assert.equal(validateHoldReason('no'), null);
  assert.equal(validateHoldReason('x'.repeat(241)), null);
  assert.equal(validateHoldReason(null), null);
});

test('ESC/POS KOT is bounded, printable text with initialize, cut, and safe notes', () => {
  const bytes = buildEscPosKot({ kotNumber: 34, orderType: 'DINE_IN', tableLabel: 'T-4', waiterName: 'Dev', createdAt: '2026-11-26T12:00:00.000Z', station: 'Grill', items: [{ name: 'Paneer Tikka', quantity: 2, notes: 'No onion\u001b@' }] });
  const output = new TextDecoder().decode(bytes);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(output.startsWith('\x1b@'));
  assert.match(output, /KOT #34/);
  assert.match(output, /2 x Paneer Tikka/);
  assert.match(output, /\x1dV/);
  assert.doesNotMatch(output, /No onion\x1b@/);
});
