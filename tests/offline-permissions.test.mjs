import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseOfflineCashShift, filterOfflinePermissions, hasFreshOfflinePermissionSnapshot, hasUnexpiredOfflinePermissionDeadline, offlinePermissionsForSnapshot, resolveOfflinePermissionSnapshot, OFFLINE_PERMISSION_TTL_MS } from '../src/lib/offline-permissions.ts';

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

test('routine workspace writes cannot extend the permission snapshot age', () => {
  const verifiedAt = 1_800_000_000_000;
  const existing = { permissions: ['orders.create'], permissionSnapshotAt: verifiedAt };
  const routineWrite = resolveOfflinePermissionSnapshot(existing, ['bills.settle'], true, undefined, verifiedAt + 60_000);
  assert.deepEqual(routineWrite, existing);
  assert.equal(hasFreshOfflinePermissionSnapshot(routineWrite.permissionSnapshotAt, verifiedAt + OFFLINE_PERMISSION_TTL_MS + 1), false);
});

test('offline UI permissions require an active deadline and expire at the boundary', () => {
  const now = 1_800_000_000_000;
  assert.equal(hasUnexpiredOfflinePermissionDeadline(now, now), true);
  assert.equal(hasUnexpiredOfflinePermissionDeadline(now - 1, now), false);
  assert.equal(hasUnexpiredOfflinePermissionDeadline(null, now), false);
  assert.equal(hasUnexpiredOfflinePermissionDeadline(Number.NaN, now), false);
});

test('fresh session reads refresh snapshots while stale writes and new unverified contexts do not', () => {
  const verifiedAt = 1_800_000_000_000;
  const existing = { permissions: ['orders.create'], permissionSnapshotAt: verifiedAt };
  assert.deepEqual(
    resolveOfflinePermissionSnapshot(existing, ['bills.settle'], true, verifiedAt + 1000, verifiedAt + 1000),
    { permissions: ['bills.settle'], permissionSnapshotAt: verifiedAt + 1000 },
  );
  assert.deepEqual(
    resolveOfflinePermissionSnapshot(existing, ['bills.settle'], true, verifiedAt - 1000, verifiedAt + 1000),
    existing,
    'an older in-flight save cannot overwrite a newer snapshot',
  );
  assert.deepEqual(
    resolveOfflinePermissionSnapshot(existing, ['bills.settle'], true, verifiedAt, verifiedAt + 1000),
    existing,
    'a parallel metadata save with the same verification timestamp cannot overwrite permissions',
  );
  assert.deepEqual(resolveOfflinePermissionSnapshot(undefined, ['bills.settle'], false, undefined, verifiedAt), { permissions: [] });
  assert.deepEqual(resolveOfflinePermissionSnapshot(undefined, ['bills.settle'], false, verifiedAt + 1, verifiedAt), { permissions: [] });
});

test('offline cash requires a recent verified open-shift snapshot', () => {
  const now = 1_800_000_000_000;
  assert.equal(canUseOfflineCashShift(true, now - OFFLINE_PERMISSION_TTL_MS, now), true);
  assert.equal(canUseOfflineCashShift(true, now - OFFLINE_PERMISSION_TTL_MS - 1, now), false);
  assert.equal(canUseOfflineCashShift(false, now, now), false);
  assert.equal(canUseOfflineCashShift(undefined, now, now), false);
  assert.equal(canUseOfflineCashShift(true, now + 1, now), false);
  assert.equal(canUseOfflineCashShift(true, undefined, now), false);
});
