export const OFFLINE_PERMISSION_TTL_MS = 12 * 60 * 60 * 1000;

export function hasFreshOfflinePermissionSnapshot(savedAt: number, now = Date.now()): boolean {
  return Number.isSafeInteger(savedAt) && savedAt <= now && now - savedAt <= OFFLINE_PERMISSION_TTL_MS;
}

export function canUseOfflineCashShift(
  cashShiftOpen: boolean | undefined,
  shiftSnapshotAt: number | undefined,
  now = Date.now(),
): boolean {
  return cashShiftOpen === true && shiftSnapshotAt !== undefined && hasFreshOfflinePermissionSnapshot(shiftSnapshotAt, now);
}

export function filterOfflinePermissions(permissions: string[] | undefined, knownPermissions: ReadonlySet<string>): string[] {
  return (permissions ?? []).filter((permission) => knownPermissions.has(permission));
}

export function offlinePermissionsForSnapshot(
  savedAt: number,
  permissions: string[] | undefined,
  knownPermissions: ReadonlySet<string>,
  now = Date.now(),
): string[] {
  return hasFreshOfflinePermissionSnapshot(savedAt, now) ? filterOfflinePermissions(permissions, knownPermissions) : [];
}
