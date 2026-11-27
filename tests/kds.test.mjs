import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateKdsTicketState, nextKdsItemState, slaBand, slaElapsedSeconds, validateHoldReason } from '../src/lib/domain/kds.ts';
import { reconcileKdsActionQueue } from '../src/lib/domain/kds-sync.ts';
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

test('offline KDS replay carries server item versions forward and removes each committed action', async () => {
  const sent = [];
  const removed = [];
  const prepared = [];
  const result = await reconcileKdsActionQueue([
    { clientMutationId: 'first', itemId: 'item-1', expectedUpdatedAt: 'cached-version' },
    { clientMutationId: 'second', itemId: 'item-1', expectedUpdatedAt: 'cached-version' },
  ], {
    send: async (action) => {
      sent.push(action);
      return { ok: true, items: [{ id: 'item-1', updatedAt: 'server-version-' + sent.length }] };
    },
    remove: async (id) => { removed.push(id); },
    prepare: async (action) => { prepared.push(action); },
    recordError: async () => assert.fail('successful actions do not record errors'),
  });
  assert.deepEqual(sent.map((action) => action.expectedUpdatedAt), ['cached-version', 'server-version-1']);
  assert.deepEqual(removed, ['first', 'second']);
  assert.deepEqual(prepared.map((action) => action.expectedUpdatedAt), ['server-version-1']);
  assert.equal(result.completed, 2);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.statusWriteFailedFor, null);
});

test('offline KDS replay stops at the first conflict and leaves later actions queued in order', async () => {
  const sent = [];
  const recorded = [];
  const removed = [];
  const prepared = [];
  const result = await reconcileKdsActionQueue([
    { clientMutationId: 'first' },
    { clientMutationId: 'second' },
  ], {
    send: async (action) => { sent.push(action.clientMutationId); return { ok: false, error: 'Ticket changed on another terminal.' }; },
    remove: async (id) => { removed.push(id); },
    prepare: async () => {},
    recordError: async (id, message) => { recorded.push([id, message]); },
  });
  assert.deepEqual(sent, ['first']);
  assert.deepEqual(removed, []);
  assert.deepEqual(recorded, [['first', 'Ticket changed on another terminal.']]);
  assert.deepEqual(result.unresolved.map((action) => action.clientMutationId), ['first', 'second']);
  assert.match(result.unresolved[1].lastError, /previous kitchen action/);
  assert.equal(result.unresolved[1].waitingForPrevious, true);
});

test('offline KDS replay reports failed local status persistence and does not send later actions', async () => {
  const sent = [];
  const result = await reconcileKdsActionQueue([
    { clientMutationId: 'first' },
    { clientMutationId: 'second' },
  ], {
    send: async (action) => { sent.push(action.clientMutationId); throw new Error('Network interrupted.'); },
    remove: async () => assert.fail('failed actions remain queued'),
    prepare: async () => {},
    recordError: async () => { throw new Error('IndexedDB write failed.'); },
  });
  assert.deepEqual(sent, ['first']);
  assert.equal(result.statusWriteFailedFor, 'first');
  assert.deepEqual(result.unresolved.map((action) => action.clientMutationId), ['first', 'second']);
});

test('offline KDS replay persists dependent versions before sending and retains committed predecessors on conflict', async () => {
  const sent = [];
  const removed = [];
  const prepared = [];
  const result = await reconcileKdsActionQueue([
    { clientMutationId: 'first', itemId: 'item-1', expectedUpdatedAt: 'old' },
    { clientMutationId: 'second', itemId: 'item-1', expectedUpdatedAt: 'old' },
  ], {
    send: async (action) => {
      sent.push(action);
      return sent.length === 1 ? { ok: true, items: [{ id: 'item-1', updatedAt: 'server-v2' }] } : { ok: false, error: 'Concurrent change.' };
    },
    remove: async (id) => { removed.push(id); },
    prepare: async (action) => { prepared.push(action); },
    recordError: async () => {},
  });
  assert.deepEqual(prepared.map((action) => action.expectedUpdatedAt), ['server-v2']);
  assert.deepEqual(sent.map((action) => action.expectedUpdatedAt), ['old', 'server-v2']);
  assert.deepEqual(removed, [], 'committed predecessor stays queued until dependent actions finish');
  assert.deepEqual(result.unresolved.map((action) => action.clientMutationId), ['first', 'second']);
});

test('offline KDS replay refuses to send a dependent action if its idempotent request version cannot be persisted', async () => {
  const sent = [];
  const result = await reconcileKdsActionQueue([
    { clientMutationId: 'first', itemId: 'item-1', expectedUpdatedAt: 'old' },
    { clientMutationId: 'second', itemId: 'item-1', expectedUpdatedAt: 'old' },
  ], {
    send: async (action) => { sent.push(action.clientMutationId); return { ok: true, items: [{ id: 'item-1', updatedAt: 'new' }] }; },
    remove: async () => assert.fail('predecessors remain when dependent payload cannot persist'),
    prepare: async () => { throw new Error('IndexedDB unavailable.'); },
    recordError: async () => {},
  });
  assert.deepEqual(sent, ['first']);
  assert.equal(result.statusWriteFailedFor, 'second');
  assert.deepEqual(result.unresolved.map((action) => action.clientMutationId), ['first', 'second']);
});

test('offline KDS lost response retry replays the exact persisted idempotent body after restart', async () => {
  let queue = [
    { clientMutationId: 'first', itemId: 'item-1', expectedUpdatedAt: 'old' },
    { clientMutationId: 'second', itemId: 'item-1', expectedUpdatedAt: 'old' },
  ];
  const committed = new Map();
  const sentBodies = [];
  const dependencies = {
    async send(action) {
      const requestBody = { action: action.action, ticketId: action.ticketId, itemId: action.itemId, expectedUpdatedAt: action.expectedUpdatedAt ?? null, reason: action.reason ?? null };
      sentBodies.push([action.clientMutationId, requestBody]);
      const prior = committed.get(action.clientMutationId);
      if (prior) {
        assert.deepEqual(requestBody, prior.requestBody, 'same mutation ID must always replay the same server payload');
        return { ok: true, items: prior.items };
      }
      const result = { items: [{ id: action.itemId, updatedAt: action.clientMutationId === 'first' ? 'version-1' : 'version-2' }] };
      committed.set(action.clientMutationId, { requestBody, items: result.items });
      if (action.clientMutationId === 'second' && sentBodies.filter(([id]) => id === 'second').length === 1) throw new Error('Response lost after server commit.');
      return { ok: true, ...result };
    },
    async remove(id) { const index = queue.findIndex((entry) => entry.clientMutationId === id); if (index >= 0) queue.splice(index, 1); },
    async prepare(action) { Object.assign(queue.find((entry) => entry.clientMutationId === action.clientMutationId), { expectedUpdatedAt: action.expectedUpdatedAt }); },
    async recordError(id, lastError) { Object.assign(queue.find((entry) => entry.clientMutationId === id), { lastError }); },
  };
  const firstAttempt = await reconcileKdsActionQueue(queue, dependencies);
  assert.match(firstAttempt.unresolved.find((entry) => entry.clientMutationId === 'second').lastError, /Response lost/);
  assert.equal(queue.length, 2, 'successful predecessors stay in the durable queue while a later action is unresolved');
  queue = structuredClone(queue); // simulate browser restart from persisted IndexedDB records
  for (const entry of queue) delete entry.lastError; // operator retries after app/browser restart
  const retry = await reconcileKdsActionQueue(queue, dependencies);
  assert.equal(retry.unresolved.length, 0);
  assert.deepEqual(queue, []);
  assert.deepEqual(sentBodies.filter(([id]) => id === 'second').map(([, body]) => body.expectedUpdatedAt), ['version-1', 'version-1']);
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
