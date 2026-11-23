export type SaleLine = { quantity: number; unitPricePaise: number; gstBps?: number; discountPaise?: number };
export type SaleTotals = { subtotalPaise: number; discountPaise: number; taxablePaise: number; taxPaise: number; serviceChargePaise: number; totalPaise: number };

/** Parse a rupee input without passing money through binary floating point. */
export function parseRupeesToPaise(value: string): number {
  const input = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(input)) throw new RangeError("Enter a non-negative amount with at most two decimal places");
  const [rupees, fraction = ""] = input.split(".");
  const paise = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Amount exceeds supported range");
  return Number(paise);
}

export type OrderWorkflowStatus = "OPEN" | "SENT" | "PREPARING" | "READY" | "SERVED" | "COMPLETED" | "CANCELLED";
export type OrderWorkflowAction = "kot-ready" | "kot-served" | "void";
export function transitionOrder(current: OrderWorkflowStatus, action: OrderWorkflowAction) {
  if (action === "void") {
    if (current === "COMPLETED" || current === "CANCELLED") throw new RangeError("Order cannot be cancelled from its current state");
    return { orderStatus: "CANCELLED" as const, kotStatus: "CANCELLED" as const };
  }
  if (action === "kot-ready" && current === "PREPARING") return { orderStatus: "READY" as const, kotStatus: "READY" as const };
  if (action === "kot-served" && current === "READY") return { orderStatus: "SERVED" as const, kotStatus: "SERVED" as const };
  throw new RangeError(`Invalid order transition: ${current} via ${action}`);
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
  return value;
}

export function calculateSale(lines: SaleLine[], options: { discountPaise?: number; serviceChargeBps?: number } = {}): SaleTotals {
  if (!lines.length) throw new RangeError("A sale needs at least one item");
  const checked = lines.map((line) => {
    safeInteger(line.quantity, "quantity"); safeInteger(line.unitPricePaise, "unit price");
    if (line.quantity <= 0 || line.unitPricePaise < 0) throw new RangeError("Quantity must be positive and price cannot be negative");
    const raw = line.quantity * line.unitPricePaise;
    const itemDiscount = safeInteger(line.discountPaise ?? 0, "item discount");
    if (itemDiscount < 0) throw new RangeError("Discount cannot be negative");
    const netBeforeOrderDiscount = Math.max(0, raw - Math.min(itemDiscount, raw));
    const rate = safeInteger(line.gstBps ?? 500, "GST rate");
    if (rate < 0 || rate > 10000) throw new RangeError("GST rate must be between 0 and 10000 basis points");
    return { raw, itemDiscount: Math.min(itemDiscount, raw), netBeforeOrderDiscount, rate };
  });
  const subtotalPaise = safeInteger(checked.reduce((sum, line) => sum + line.raw, 0), "subtotal");
  const itemDiscountTotal = checked.reduce((sum, line) => sum + line.itemDiscount, 0);
  const discountBase = checked.reduce((sum, line) => sum + line.netBeforeOrderDiscount, 0);
  const requestedDiscount = safeInteger(options.discountPaise ?? 0, "discount");
  if (requestedDiscount < 0) throw new RangeError("Discount cannot be negative");
  const orderDiscount = Math.min(requestedDiscount, discountBase);
  const discountShares = allocatePaise(BigInt(orderDiscount), checked.map((line) => BigInt(line.netBeforeOrderDiscount)));
  const taxableLines = checked.map((line, index) => line.netBeforeOrderDiscount - Number(discountShares[index]));
  const discountPaise = itemDiscountTotal + orderDiscount;
  const taxablePaise = safeInteger(taxableLines.reduce((sum, amount) => sum + amount, 0), "taxable subtotal");
  const taxPaise = safeInteger(checked.reduce((sum, line, index) => sum + Math.round(taxableLines[index] * line.rate / 10000), 0), "GST total");
  const serviceChargeBps = safeInteger(options.serviceChargeBps ?? 0, "service charge rate");
  if (serviceChargeBps < 0 || serviceChargeBps > 10000) throw new RangeError("Service charge rate must be between 0 and 10000 basis points");
  const serviceChargePaise = Math.round(taxablePaise * serviceChargeBps / 10000);
  const totalPaise = safeInteger(taxablePaise + taxPaise + serviceChargePaise, "total");
  return { subtotalPaise, discountPaise, taxablePaise, taxPaise, serviceChargePaise, totalPaise };
}

export function paymentStatus(totalPaise: number, paidPaise: number): "PENDING" | "PARTIAL" | "PAID" {
  safeInteger(totalPaise, "total"); safeInteger(paidPaise, "paid amount");
  if (totalPaise < 0 || paidPaise < 0) throw new RangeError("Amounts cannot be negative");
  if (paidPaise > totalPaise) throw new RangeError("Payment cannot exceed the bill total");
  if (paidPaise === 0) return "PENDING";
  if (paidPaise < totalPaise) return "PARTIAL";
  return "PAID";
}

export function reconcileCash(openingCashPaise: number, cashPayments: number[], countedCashPaise: number) {
  for (const value of [openingCashPaise, countedCashPaise, ...cashPayments]) {
    safeInteger(value, "cash amount"); if (value < 0) throw new RangeError("Cash amounts cannot be negative");
  }
  const expectedCashPaise = openingCashPaise + cashPayments.reduce((a, b) => a + b, 0);
  return { expectedCashPaise, countedCashPaise, variancePaise: countedCashPaise - expectedCashPaise };
}

export function applyStockChange(currentMilli: number, deltaMilli: number, allowNegative = false) {
  safeInteger(currentMilli, "current stock"); safeInteger(deltaMilli, "stock change");
  const next = currentMilli + deltaMilli;
  if (next < 0 && !allowNegative) throw new RangeError("Insufficient stock");
  return next;
}

export type SyncMutation<T> = { clientMutationId: string; payload: T };
export function applyIdempotently<T, R>(mutation: SyncMutation<T>, applied: Map<string, R>, handler: (payload: T) => R): R {
  if (!mutation.clientMutationId.trim()) throw new RangeError("A client mutation ID is required");
  if (applied.has(mutation.clientMutationId)) return applied.get(mutation.clientMutationId)!;
  const result = handler(mutation.payload);
  applied.set(mutation.clientMutationId, result);
  return result;
}

export function splitByAmounts(totalPaise: number, amounts: number[]) {
  safeInteger(totalPaise, "total");
  amounts.forEach((amount) => safeInteger(amount, "split amount"));
  if (totalPaise < 0 || amounts.some((amount) => amount < 0)) throw new RangeError("Amounts cannot be negative");
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (sum !== totalPaise) throw new RangeError("Split amounts must add up to the bill total");
  return amounts;
}

export function allocatePaise(totalPaise: bigint, weights: bigint[]) {
  if (totalPaise < 0n || !weights.length || weights.some((weight) => weight < 0n)) throw new RangeError("Split weights and total cannot be negative");
  if (totalPaise === 0n) return weights.map(() => 0n);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightTotal === 0n) throw new RangeError("Split weights must have a positive total");
  const portions = weights.map((weight, index) => ({ index, amount: totalPaise * weight / weightTotal, remainder: totalPaise * weight % weightTotal }));
  let remaining = totalPaise - portions.reduce((sum, portion) => sum + portion.amount, 0n);
  portions.sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let i = 0; remaining > 0n; i++, remaining--) portions[i].amount += 1n;
  return portions.sort((a, b) => a.index - b.index).map((portion) => portion.amount);
}
