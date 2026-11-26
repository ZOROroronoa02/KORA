export const itemStates = ["QUEUED", "COOKING", "READY", "BUMPED", "OUT_OF_STOCK"] as const;
export type KdsItemState = typeof itemStates[number];
export type KdsTicketStatus = "QUEUED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";

const nextState: Partial<Record<KdsItemState, KdsItemState>> = {
  QUEUED: "COOKING",
  COOKING: "READY",
  READY: "BUMPED",
};

export function nextKdsItemState(state: KdsItemState): KdsItemState | null {
  return nextState[state] ?? null;
}

export function aggregateKdsTicketState(states: readonly KdsItemState[]): KdsTicketStatus {
  if (!states.length) return "QUEUED";
  const active = states.filter((state) => state !== "OUT_OF_STOCK");
  if (!active.length) return "CANCELLED";
  if (active.length && active.every((state) => state === "BUMPED")) return "SERVED";
  if (active.length && active.every((state) => state === "READY" || state === "BUMPED")) return "READY";
  if (active.some((state) => state === "COOKING" || state === "READY" || state === "BUMPED")) return "PREPARING";
  return "QUEUED";
}

type TimeInput = Date | number | string;
const timestamp = (value: TimeInput) => value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;

export function slaElapsedSeconds(input: { createdAt: TimeInput; now: TimeInput; holdDurationSeconds?: number; heldAt?: TimeInput | null }) {
  const created = timestamp(input.createdAt);
  const now = timestamp(input.now);
  const heldAt = input.heldAt === null || input.heldAt === undefined ? null : timestamp(input.heldAt);
  const activeHold = heldAt === null ? 0 : Math.max(0, now - heldAt) / 1000;
  return Math.max(0, Math.floor((now - created) / 1000 - (input.holdDurationSeconds ?? 0) - activeHold));
}

export function slaBand(elapsedSeconds: number, targetMinutes: number): "green" | "amber" | "red" {
  const target = Math.max(1, targetMinutes) * 60;
  if (elapsedSeconds <= target) return "green";
  if (elapsedSeconds <= target * 1.5) return "amber";
  return "red";
}

export function validateHoldReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason.length >= 3 && reason.length <= 240 ? reason : null;
}
