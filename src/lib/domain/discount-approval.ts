export type DiscountApprovalPolicy = {
  discountApprovalThresholdPct?: number;
};

/** Returns true only when a valid discount crosses the outlet's approval threshold. */
export function requiresDiscountApproval(discountBps: number, settings: DiscountApprovalPolicy) {
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) {
    throw new RangeError("Discount must be an integer from 0 to 10000 basis points.");
  }
  const thresholdPct = settings.discountApprovalThresholdPct ?? 10;
  if (!Number.isFinite(thresholdPct) || thresholdPct < 0 || thresholdPct > 100) {
    throw new RangeError("Discount approval threshold must be between 0 and 100 percent.");
  }
  return discountBps > thresholdPct * 100;
}

export function settingsForOutlet(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} satisfies DiscountApprovalPolicy;
  const settings = value as Record<string, unknown>;
  const threshold = settings.discountApprovalThresholdPct;
  return {
    discountApprovalThresholdPct: typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 && threshold <= 100 ? threshold : 10,
  } satisfies DiscountApprovalPolicy;
}
