export class RequestInputError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) { super(message); this.statusCode = statusCode; this.name = "RequestInputError"; }
}

/** Parse a bounded JSON object without buffering an untrusted body in full. */
export async function readJsonObject(request: Request, maximumBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new RequestInputError("Invalid Content-Length header.");
    if (Number(contentLength) > maximumBytes) throw new RequestInputError("Request body is too large.", 413);
  }

  if (!request.body) throw new RequestInputError("Request body must be valid JSON.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("Request body exceeds the configured limit.").catch(() => undefined);
        throw new RequestInputError("Request body is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: string;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new RequestInputError("Request body must be valid UTF-8."); }
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new RequestInputError("Request body must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestInputError("Request body must be a JSON object.");
  return value as Record<string, unknown>;
}
