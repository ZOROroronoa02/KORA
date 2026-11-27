/** Produce a strictly increasing per-outlet timestamp for durable FIFO queues. */
export function nextOfflineQueueTimestamp(now: number, latest: number | undefined): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Queue timestamp must be a non-negative safe integer.");
  if (latest === undefined) return now;
  if (!Number.isSafeInteger(latest) || latest < 0) throw new RangeError("Stored queue timestamp must be a non-negative safe integer.");
  const next = Math.max(now, latest + 1);
  if (!Number.isSafeInteger(next)) throw new RangeError("Queue timestamp sequence exceeded safe integer precision.");
  return next;
}
