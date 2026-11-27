export const OFFLINE_PERMISSION_TTL_MS = 12 * 60 * 60 * 1000;

export type OfflinePermissionSnapshot = { permissions?: string[]; permissionSnapshotAt?: number };

/**
 * Only a timestamp from a successful full session read may refresh cached permissions.
 * Menu/shift updates can persist workspace metadata but must not extend authorization age.
 */
export function resolveOfflinePermissionSnapshot(
  existing: OfflinePermissionSnapshot | undefined,
  incomingPermissions: string[] | undefined,
  sameContext: boolean,
  verifiedAt: number | undefined,
  now = Date.now(),
): OfflinePermissionSnapshot {
  const existingAt = existing?.permissionSnapshotAt;
  const existingTimestampValid = Number.isSafeInteger(existingAt) && (existingAt as number) <= now;
  const verifiedTimestampValid = Number.isSafeInteger(verifiedAt) && (verifiedAt as number) <= now;

  if (verifiedTimestampValid && (!sameContext || !existingTimestampValid || (verifiedAt as number) > (existingAt as number))) {
    return { permissions: incomingPermissions ?? [], permissionSnapshotAt: verifiedAt };
  }
  if (sameContext && existingTimestampValid) {
    return { permissions: existing?.permissions ?? [], permissionSnapshotAt: existingAt };
  }
  return { permissions: [] };
}

export function hasFreshOfflinePermissionSnapshot(savedAt: number, now = Date.now()): boolean {
  return Number.isSafeInteger(savedAt) && savedAt <= now && now - savedAt <= OFFLINE_PERMISSION_TTL_MS;
}

export function hasUnexpiredOfflinePermissionDeadline(expiresAt: number | null, now = Date.now()): boolean {
  return expiresAt !== null && Number.isSafeInteger(expiresAt) && expiresAt >= now;
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
