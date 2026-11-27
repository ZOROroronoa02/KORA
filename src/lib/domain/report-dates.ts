const DAY_MS = 24 * 60 * 60 * 1000;
const INDIA_OFFSET_MS = 330 * 60 * 1000;
export const MAX_REPORT_RANGE_DAYS = 93;

export function indiaDateString(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function indiaDateBoundary(value: string, nextDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utcDay = Date.UTC(year, month - 1, day);
  const checked = new Date(utcDay);
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) return null;
  return new Date(utcDay + (nextDay ? DAY_MS : 0) - INDIA_OFFSET_MS);
}

export function parseIndiaReportRange(from: string, to: string, maxDays = MAX_REPORT_RANGE_DAYS) {
  const startsAt = indiaDateBoundary(from);
  const endsAt = indiaDateBoundary(to, true);
  if (!startsAt || !endsAt || endsAt <= startsAt) return { ok: false as const, reason: "invalid" as const };
  if (!Number.isSafeInteger(maxDays) || maxDays < 1 || endsAt.getTime() - startsAt.getTime() > maxDays * DAY_MS) {
    return { ok: false as const, reason: "too-long" as const };
  }
  return { ok: true as const, startsAt, endsAt };
}
