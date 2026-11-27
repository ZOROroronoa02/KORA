import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOfflinePermissions, hasFreshOfflinePermissionSnapshot, offlinePermissionsForSnapshot, OFFLINE_PERMISSION_TTL_MS } from '../src/lib/offline-permissions.ts';

test('offline permissions are usable through the exact 12-hour boundary only', () => {
  const now = 1_800_000_000_000;
  assert.equal(hasFreshOfflinePermissionSnapshot(now - OFFLINE_PERMISSION_TTL_MS, now), true);
  assert.equal(hasFreshOfflinePermissionSnapshot(now - OFFLINE_PERMISSION_TTL_MS - 1, now), false);
  assert.equal(hasFreshOfflinePermissionSnapshot(now + 1, now), false);
  assert.equal(hasFreshOfflinePermissionSnapshot(Number.NaN, now), false);
});

test('offline permission cache drops unknown and missing permission claims', () => {
  const known = new Set(['orders.create', 'bills.settle']);
  assert.deepEqual(filterOfflinePermissions(['orders.create', 'platform.superuser'], known), ['orders.create']);
  assert.deepEqual(filterOfflinePermissions(undefined, known), []);
  assert.deepEqual(offlinePermissionsForSnapshot(500, ['bills.settle'], known, 500 + OFFLINE_PERMISSION_TTL_MS), ['bills.settle']);
  assert.deepEqual(offlinePermissionsForSnapshot(499, ['bills.settle'], known, 500 + OFFLINE_PERMISSION_TTL_MS), []);
});
