"use client";

import Dexie, { type Table } from "dexie";

export type CloudOrderPayload = {
  outletId: string;
  clientMutationId: string;
  deviceId: string;
  type: "Dine in" | "Takeaway" | "Delivery";
  tableId?: string;
  customerId?: string;
  buyerDetails?: {
    name?: string;
    gstin?: string;
    address?: { line1?: string; line2?: string; city?: string; state?: string; pincode?: string };
  };
  items: Array<{ menuItemId: string; quantity: number; note?: string }>;
  paidPaise: number;
  discountBps?: number;
  paymentMethod?: "Cash" | "Card" | "UPI";
};

export type CachedDisplayOrder = {
  id: string; items: Array<{ id: string; productId: string; name: string; price: number; qty: number; note?: string }>;
  type: string; table: string; total: number; status: string; time: string;
  payment: string; paidAmount?: number; customer: string; syncState?: "queued" | "needs-attention";
  provisionalEstimate?: {
    createdAt: string;
    subtotalPaise: number;
    discountPaise: number;
    serviceChargePaise: number;
    taxPaise: number;
    totalPaise: number;
    paidPaise: number;
    paymentMethod?: string;
  };
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

export type KdsTicketSnapshot = { outletId: string; tickets: unknown[]; stations?: unknown[]; settings?: unknown; outlet?: unknown; savedAt: number };
export type PendingKdsAction = {
  clientMutationId: string;
  outletId: string;
  action: string;
  ticketId: string;
  itemId?: string;
  expectedUpdatedAt?: string;
  reason?: string;
  createdAt: number;
  lastError?: string;
};

class KoraPosDatabase extends Dexie {
  pendingOrders!: Table<PendingOrder, string>;
  menuSnapshots!: Table<{ outletId: string; savedAt: number; categories: unknown[]; tables?: Array<{ id: string; label: string; section?: string | null; capacity: number; occupied?: boolean }>; serviceChargeBps?: number }, string>;
  offlineWorkspace!: Table<{ id: "last"; userId: string; userName: string; outletId: string; outletName: string; role: string; permissions?: string[]; savedAt: number }, string>;
  kdsSnapshots!: Table<KdsTicketSnapshot, string>;
  kdsActions!: Table<PendingKdsAction, string>;
  constructor() {
    super("kora-pos-offline-v1");
    this.version(1).stores({ pendingOrders: "clientMutationId, outletId, createdAt", menuSnapshots: "outletId" });
    this.version(2).stores({ pendingOrders: "clientMutationId, outletId, createdAt", menuSnapshots: "outletId", offlineWorkspace: "id" });
    this.version(3).stores({ pendingOrders: "clientMutationId, outletId, createdAt", menuSnapshots: "outletId", offlineWorkspace: "id", kdsSnapshots: "outletId,savedAt", kdsActions: "clientMutationId,outletId,createdAt" });
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

export async function cacheOfflineWorkspace(workspace: { userId: string; userName: string; outletId: string; outletName: string; role: string; permissions?: string[] }) {
  await database.offlineWorkspace.put({ id: "last", ...workspace, savedAt: Date.now() });
}

export async function cacheKdsTickets(outletId: string, tickets: unknown[], metadata?: Pick<KdsTicketSnapshot, "stations" | "settings" | "outlet">) {
  const existing = await database.kdsSnapshots.get(outletId);
  await database.kdsSnapshots.put({ ...existing, ...metadata, outletId, tickets, savedAt: Date.now() });
}

export async function readKdsTickets(outletId: string) {
  return database.kdsSnapshots.get(outletId);
}

export async function queueKdsAction(action: PendingKdsAction) {
  await database.kdsActions.put(action);
}

export async function getPendingKdsActions(outletId: string) {
  return database.kdsActions.where("outletId").equals(outletId).sortBy("createdAt");
}

export async function removeKdsAction(clientMutationId: string) {
  await database.kdsActions.delete(clientMutationId);
}

export async function updateKdsActionError(clientMutationId: string, lastError: string) {
  await database.kdsActions.update(clientMutationId, { lastError });
}

export async function readOfflineWorkspace() {
  return database.offlineWorkspace.get("last");
}

export async function clearOfflineWorkspace() {
  await database.offlineWorkspace.delete("last");
}
