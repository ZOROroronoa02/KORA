/** Normalize Prisma serialization/deadlock failures, including SQL errors wrapped by $queryRaw. */
export function isTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const candidate = error as { code?: unknown; meta?: unknown };
  if (candidate.code === "P2034") return true;
  if (candidate.code !== "P2010" || !candidate.meta || typeof candidate.meta !== "object") return false;
  const sqlState = (candidate.meta as { code?: unknown }).code;
  return sqlState === "40001" || sqlState === "40P01";
}
