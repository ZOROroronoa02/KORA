import { createHash } from "node:crypto";

export type OrderRequestIdentity = {
  outletId: string;
  deviceId: string;
  type: string;
  items: Array<{ menuItemId: unknown; quantity: unknown; note: string | null }>;
  paidPaise: number;
  discountBps: number;
  paymentMethod: string | null;
  customerId: string | null;
  tableId: string | null;
  buyerDetails: unknown;
  kitchenNote: string | null;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function createOrderRequestHash(identity: OrderRequestIdentity): string {
  return createHash("sha256").update(stableJson(identity)).digest("hex");
}
