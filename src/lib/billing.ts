export type SaleLine = { quantity: number; unitPricePaise: number; gstBps?: number; discountPaise?: number };
export type SaleTotals = { subtotalPaise: number; discountPaise: number; taxablePaise: number; taxPaise: number; serviceChargePaise: number; totalPaise: number };
export type SaleLineBreakdown = { taxablePaise: number; serviceChargePaise: number; gstBps: number; taxPaise: number; totalPaise: number };

/** Parse a rupee input without passing money through binary floating point. */
export function parseRupeesToPaise(value: string): number {
  const input = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(input)) throw new RangeError("Enter a non-negative amount with at most two decimal places");
  const [rupees, fraction = ""] = input.split(".");
  const paise = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Amount exceeds supported range");
  return Number(paise);
}

/** Return the Indian financial-year label for a timestamp interpreted in Asia/Kolkata. */
export function indianFinancialYear(date: Date): { label: string; startYear: number } {
  if (Number.isNaN(date.getTime())) throw new RangeError("A valid date is required");
  const parts = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "numeric" }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month)) throw new RangeError("Could not determine Indian financial year");
  const startYear = month >= 4 ? year : year - 1;
  return { startYear, label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}` };
}

/** Format a GST invoice serial within Rule 46's 16-character limit. */
export function formatInvoiceNumber(prefix: string, financialYear: string, sequence: number): string {
  if (!/^[A-Z0-9]{1,2}$/.test(prefix)) throw new RangeError("Invoice prefix must be one or two uppercase letters or digits.");
  const year = /^(\d{4})-(\d{2})$/.exec(financialYear);
  if (!year || Number(year[2]) !== (Number(year[1]) + 1) % 100) throw new RangeError("Financial year label is invalid.");
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError("Invoice sequence is invalid.");
  const compactYear = `${year[1].slice(-2)}${year[2]}`;
  const serial = String(sequence).padStart(6, "0");
  const invoiceNumber = `${prefix}-FY${compactYear}-${serial}`;
  if (invoiceNumber.length > 16) throw new RangeError("Invoice sequence has reached the 16-character GST serial limit for this prefix.");
  return invoiceNumber;
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

/** Apply a non-negative basis-point rate with exact paise precision and half-up rounding. */
function applyBasisPoints(amountPaise: number, basisPoints: number, label: string): number {
  safeInteger(amountPaise, label);
  safeInteger(basisPoints, `${label} rate`);
  if (amountPaise < 0 || basisPoints < 0) throw new RangeError(`${label} and its rate cannot be negative`);
  const rounded = (BigInt(amountPaise) * BigInt(basisPoints) + 5_000n) / 10_000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} exceeds supported range`);
  return Number(rounded);
}

export function calculateSaleBreakdown(lines: SaleLine[], options: { discountPaise?: number; serviceChargeBps?: number } = {}): SaleTotals & { lines: SaleLineBreakdown[] } {
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
  const itemTaxablePaise = safeInteger(taxableLines.reduce((sum, amount) => sum + amount, 0), "taxable subtotal");
  const serviceChargeBps = safeInteger(options.serviceChargeBps ?? 0, "service charge rate");
  if (serviceChargeBps < 0 || serviceChargeBps > 10000) throw new RangeError("Service charge rate must be between 0 and 10000 basis points");
  const serviceChargePaise = applyBasisPoints(itemTaxablePaise, serviceChargeBps, "Service charge");
  // Treat service charge as part of the taxable consideration and apply each line's GST rate.
  const serviceChargeShares = allocatePaise(BigInt(serviceChargePaise), taxableLines.map((amount) => BigInt(amount)));
  const lineBreakdown = checked.map((line, index) => {
    const lineServiceChargePaise = Number(serviceChargeShares[index]);
    const lineTaxablePaise = taxableLines[index] + lineServiceChargePaise;
    const lineTaxPaise = applyBasisPoints(lineTaxablePaise, line.rate, "GST");
    return { taxablePaise: lineTaxablePaise, serviceChargePaise: lineServiceChargePaise, gstBps: line.rate, taxPaise: lineTaxPaise, totalPaise: lineTaxablePaise + lineTaxPaise };
  });
  const taxPaise = safeInteger(lineBreakdown.reduce((sum, line) => sum + line.taxPaise, 0), "GST total");
  const taxablePaise = safeInteger(itemTaxablePaise + serviceChargePaise, "taxable subtotal");
  const totalPaise = safeInteger(taxablePaise + taxPaise, "total");
  return { subtotalPaise, discountPaise, taxablePaise, taxPaise, serviceChargePaise, totalPaise, lines: lineBreakdown };
}

export function calculateSale(lines: SaleLine[], options: { discountPaise?: number; serviceChargeBps?: number } = {}): SaleTotals {
  const { lines: _lineBreakdown, ...totals } = calculateSaleBreakdown(lines, options);
  return totals;
}

export function paymentStatus(totalPaise: number, paidPaise: number): "PENDING" | "PARTIAL" | "PAID" {
  safeInteger(totalPaise, "total"); safeInteger(paidPaise, "paid amount");
  if (totalPaise < 0 || paidPaise < 0) throw new RangeError("Amounts cannot be negative");
  if (paidPaise > totalPaise) throw new RangeError("Payment cannot exceed the bill total");
  if (paidPaise === 0) return "PENDING";
  if (paidPaise < totalPaise) return "PARTIAL";
  return "PAID";
}

/** Validate a positive refund against the remaining unrefunded amount of its source payment. */
export function addRefundWithinPaidBalance(grossPaidPaise: number, refundedPaise: number, amountPaise: number): number {
  for (const [value, label] of [[grossPaidPaise, "gross paid"], [refundedPaise, "refunded amount"], [amountPaise, "refund amount"]] as const) safeInteger(value, label);
  if (grossPaidPaise < 0 || refundedPaise < 0 || amountPaise <= 0) throw new RangeError("Paid and refunded amounts must be non-negative, and refund must be positive");
  if (refundedPaise > grossPaidPaise || amountPaise > grossPaidPaise - refundedPaise) throw new RangeError("Refund exceeds the unrefunded payment balance");
  return refundedPaise + amountPaise;
}

/** Compute bill status after netting immutable refunds against successful payments. */
export function paymentStatusAfterRefund(totalPaise: number, grossPaidPaise: number, refundedPaise: number): "PENDING" | "PARTIAL" | "PAID" | "REFUNDED" {
  safeInteger(totalPaise, "total"); safeInteger(grossPaidPaise, "gross paid"); safeInteger(refundedPaise, "refunded amount");
  if (totalPaise < 0 || grossPaidPaise < 0 || refundedPaise < 0 || refundedPaise > grossPaidPaise) throw new RangeError("Invalid refunded payment balance");
  const netPaidPaise = grossPaidPaise - refundedPaise;
  if (refundedPaise > 0 && netPaidPaise === 0) return "REFUNDED";
  return paymentStatus(totalPaise, netPaidPaise);
}

/** Return the new settled amount only when this payment fits the remaining balance. */
export function addPaymentWithinBalance(totalPaise: number, paidPaise: number, amountPaise: number): number {
  safeInteger(totalPaise, "bill total");
  safeInteger(paidPaise, "paid amount");
  safeInteger(amountPaise, "payment amount");
  if (totalPaise < 0 || paidPaise < 0 || amountPaise <= 0) {
    throw new RangeError("Bill total and paid amount must be non-negative, and payment must be positive");
  }
  if (paidPaise > totalPaise || amountPaise > totalPaise - paidPaise) {
    throw new RangeError("Payment exceeds the outstanding bill balance");
  }
  return paidPaise + amountPaise;
}

export function reconcileCash(openingCashPaise: number, cashPayments: number[], countedCashPaise: number, cashRefundsPaise = 0) {
  for (const value of [openingCashPaise, countedCashPaise, cashRefundsPaise, ...cashPayments]) {
    safeInteger(value, "cash amount"); if (value < 0) throw new RangeError("Cash amounts cannot be negative");
  }
  const expectedCashPaise = openingCashPaise + cashPayments.reduce((a, b) => a + b, 0) - cashRefundsPaise;
  safeInteger(expectedCashPaise, "expected cash");
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
