export const realtimeEventPermissions: Record<string, readonly string[]> = {
  "order:new": ["orders.read", "kds.view"],
  "order:updated": ["orders.read", "kds.view", "bills.settle"],
  "kot:status": ["orders.read", "kds.view"],
  "kot:created": ["kds.view"],
  "kot:item:updated": ["kds.view"],
  "kot:updated": ["kds.view"],
  "kot:recalled": ["kds.view"],
  "kot:86-item": ["kds.view"],
  "menu:updated": ["menu.view"],
  "shift:updated": ["shift.open", "shift.close"],
};

export function realtimePermissionRoom(tenantId: string, outletId: string, permission: string) {
  return `tenant:${tenantId}:outlet:${outletId}:permission:${permission}`;
}

export function realtimeRoomsForEvent(tenantId: string, outletId: string, event: string) {
  return (realtimeEventPermissions[event] ?? []).map((permission) => realtimePermissionRoom(tenantId, outletId, permission));
}
