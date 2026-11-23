export class RequestInputError extends Error {
  constructor(message: string) { super(message); this.name = "RequestInputError"; }
}

/** Parse a bounded JSON object so malformed bodies fail as client errors, not 500s. */
export async function readJsonObject(request: Request, maximumBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBytes) throw new RequestInputError("Request body is too large.");
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new RequestInputError("Request body must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestInputError("Request body must be a JSON object.");
  return value as Record<string, unknown>;
}
