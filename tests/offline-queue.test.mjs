import test from 'node:test';
import assert from 'node:assert/strict';
import { nextOfflineQueueTimestamp } from '../src/lib/domain/offline-queue.ts';

test('offline queue timestamps preserve order for same-millisecond enqueues', () => {
  assert.equal(nextOfflineQueueTimestamp(1_000, 1_000), 1_001);
});

test('offline queue timestamps remain ordered when the device clock moves backwards', () => {
  assert.equal(nextOfflineQueueTimestamp(900, 1_000), 1_001);
});

test('offline queue timestamps use current time when it is later than prior entries', () => {
  assert.equal(nextOfflineQueueTimestamp(1_100, 1_000), 1_100);
  assert.equal(nextOfflineQueueTimestamp(1_000, undefined), 1_000);
});

test('offline queue timestamp rejects corrupt and precision-losing values', () => {
  assert.throws(() => nextOfflineQueueTimestamp(Number.NaN, 1_000), RangeError);
  assert.throws(() => nextOfflineQueueTimestamp(1_000, Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => nextOfflineQueueTimestamp(1_000, Number.MAX_SAFE_INTEGER), RangeError);
});
