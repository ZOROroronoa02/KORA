import { createHmac, timingSafeEqual } from "node:crypto";

export type AggregatorType = "SWIGGY" | "ZOMATO" | string;
export type UnifiedAggregatorOrder = {
  provider: AggregatorType;
  providerOrderId: string;
  outletCode: string;
  customerName?: string;
  customerPhone?: string;
  items: Array<{ name: string; quantity: number; unitPricePaise: number; notes?: string }>;
  totalPaise: number;
  placedAt: string;
  raw: unknown;
};

export interface AggregatorAdapter<TPayload = unknown> {
  provider: AggregatorType;
  signatureHeader: string;
  secretEnvironmentVariable: string;
  verify(rawBody: string, signature: string): boolean;
  normalize(payload: TPayload): UnifiedAggregatorOrder;
}

export function createHmacVerifier(secretEnvironmentVariable: string) {
  return (rawBody: string, signature: string) => {
    const secret = process.env[secretEnvironmentVariable];
    if (!secret || !signature) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    const given = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
}

const adapters = new Map<AggregatorType, AggregatorAdapter>();
export function registerAggregatorAdapter(adapter: AggregatorAdapter) { adapters.set(adapter.provider, adapter); }
export function getAggregatorAdapter(provider: string) { return adapters.get(provider.toUpperCase()); }
export function registeredAggregatorProviders() { return [...adapters.keys()]; }
