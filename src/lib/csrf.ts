/** Same-origin guard for endpoints authenticated by an automatically sent cookie. */
export function isSameOriginRequest(request: Request) {
  if (process.env.NODE_ENV === "production" && !process.env.KORA_APP_ORIGIN) return false;
  let expectedOrigin: string;
  try {
    expectedOrigin = process.env.KORA_APP_ORIGIN
      ? new URL(process.env.KORA_APP_ORIGIN).origin
      : new URL(request.url).origin;
  } catch { return false; }

  const origin = request.headers.get("origin");
  if (origin) {
    try { return new URL(origin).origin === expectedOrigin; }
    catch { return false; }
  }
  return request.headers.get("sec-fetch-site") !== "cross-site";
}
