import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const imageSources = ["'self'", "blob:", "data:"];
  const styleSources = ["'self'", `'nonce-${nonce}'`, "https://fonts.googleapis.com"];
  const fontSources = ["'self'", "data:", "https://fonts.gstatic.com"];
  if (process.env.NEXT_PUBLIC_ASSET_ORIGIN) {
    try { imageSources.push(new URL(process.env.NEXT_PUBLIC_ASSET_ORIGIN).origin); }
    catch { /* Invalid asset origins stay blocked by the default policy. */ }
  }
  const connectSources = ["'self'"];
  if (isDev) connectSources.push("ws:", "wss:");
  if (process.env.NEXT_PUBLIC_REALTIME_URL) {
    try {
      const realtime = new URL(process.env.NEXT_PUBLIC_REALTIME_URL);
      connectSources.push(realtime.origin);
      realtime.protocol = realtime.protocol === "https:" || realtime.protocol === "wss:" ? "wss:" : "ws:";
      connectSources.push(realtime.origin);
    } catch { /* Invalid realtime origins stay blocked. */ }
  }
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src " + styleSources.join(" "),
    ...(isDev ? ["style-src-attr 'unsafe-inline'"] : []),
    "img-src " + imageSources.join(" "),
    "font-src " + fontSources.join(" "),
    "connect-src " + connectSources.join(" "),
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
