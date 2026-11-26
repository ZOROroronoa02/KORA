"use client";

import Dexie, { type Table } from "dexie";

export type CloudOrderPayload = {
  outletId: string;
  clientMutationId: string;
  deviceId: string;
  type: "Dine in" | "Takeaway" | "Delivery";
  tableId?: string;
  customerId?: string;
  items: Array<{ menuItemId: string; quantity: number; note?: string }>;
  paidPaise: number;
  discountBps?: number;
  paymentMethod?: "Cash" | "Card" | "UPI";
};

export type CachedDisplayOrder = {
  id: string; items: Array<{ id: string; productId: string; name: string; price: number; qty: number; note?: string }>;
  type: string; table: string; total: number; status: string; time: string;
  payment: string; paidAmount?: number; customer: string; syncState?: "queued" | "needs-attention";
};

export type PendingOrder = {
  clientMutationId: string;
  outletId: string;
  payload: CloudOrderPayload;
  displayOrder: CachedDisplayOrder;
  createdAt: number;
  lastError?: string;
  nextAttemptAt?: number;
  retryCount?: number;
};

class KoraPosDatabase extends Dexie {
  pendingOrders!: Table<PendingOrder, string>;
  menuSnapshots!: Table<{ outletId: string; savedAt: number; categories: unknown[]; tables?: Array<{ id: string; label: string; section?: string | null; capacity: number; occupied?: boolean }>; serviceChargeBps?: number }, string>;
  offlineWorkspace!: Table<{ id: "last"; userId: string; userName: string; outletId: string; outletName: string; role: string; savedAt: number }, string>;
  constructor() {
    super("kora-pos-offline-v1");
    this.version(1).stores({ pendingOrders: "clientMutationId, outletId, createdAt", menuSnapshots: "outletId" });
    this.version(2).stores({ pendingOrders: "clientMutationId, outletId, createdAt", menuSnapshots: "outletId", offlineWorkspace: "id" });
  }
}

const database = new KoraPosDatabase();

export function getDeviceId() {
  const key = "kora-device-id";
  let value = localStorage.getItem(key);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(key, value); }
  return value;
}

export async function queueOrder(order: PendingOrder) {
  await database.pendingOrders.put(order);
}

export async function getPendingOrders(outletId: string) {
  return database.pendingOrders.where("outletId").equals(outletId).sortBy("createdAt");
}

export async function removePendingOrder(clientMutationId: string) {
  await database.pendingOrders.delete(clientMutationId);
}

export async function updatePendingOrderError(clientMutationId: string, lastError: string, retryCount = 0, nextAttemptAt = 0) {
  await database.pendingOrders.update(clientMutationId, { lastError, retryCount, nextAttemptAt });
}

export async function cacheMenu(outletId: string, categories: unknown[]) {
  const existing = await database.menuSnapshots.get(outletId);
  await database.menuSnapshots.put({ ...existing, outletId, categories, savedAt: Date.now() });
}

export async function readCachedMenu(outletId: string) {
  return database.menuSnapshots.get(outletId);
}

export async function cacheTables(outletId: string, tables: NonNullable<Awaited<ReturnType<typeof readCachedMenu>>>["tables"], serviceChargeBps: number) {
  const existing = await database.menuSnapshots.get(outletId);
  await database.menuSnapshots.put({ outletId, categories: existing?.categories ?? [], tables, serviceChargeBps, savedAt: Date.now() });
}

export async function cacheOfflineWorkspace(workspace: { userId: string; userName: string; outletId: string; outletName: string; role: string }) {
  await database.offlineWorkspace.put({ id: "last", ...workspace, savedAt: Date.now() });
}

export async function readOfflineWorkspace() {
  return database.offlineWorkspace.get("last");
}

export async function clearOfflineWorkspace() {
  await database.offlineWorkspace.delete("last");
}
