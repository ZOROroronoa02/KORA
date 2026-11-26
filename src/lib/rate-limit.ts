import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createClient, type RedisClientType } from "redis";

type Bucket = { count: number; expiresAt: number };
const memory = new Map<string, Bucket>();
let client: RedisClientType | undefined;
let clientReady: Promise<RedisClientType> | undefined;

export class RateLimitUnavailableError extends Error {
  constructor(message = "Rate limiting is unavailable.") { super(message); this.name = "RateLimitUnavailableError"; }
}

async function redis(): Promise<RedisClientType | null> {
  if (!process.env.REDIS_URL) {
    if (process.env.NODE_ENV === "production") throw new RateLimitUnavailableError("REDIS_URL is required for production API rate limits.");
    return null;
  }
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on("error", () => undefined);
    clientReady = client.connect().then(() => client!).catch((error: unknown) => {
      client = undefined;
      clientReady = undefined;
      throw error;
    });
  }
  const pending = clientReady;
  if (!pending) throw new RateLimitUnavailableError();
  try { return await pending; }
  catch {
    if (process.env.NODE_ENV === "production") throw new RateLimitUnavailableError();
    return null;
  }
}

export function getRateLimitClientIp(request: Request) {
  if (process.env.NODE_ENV === "production") {
    const secret = process.env.KORA_PROXY_SHARED_SECRET ?? "";
    const ip = request.headers.get("x-kora-client-ip")?.trim() ?? "";
    const signature = request.headers.get("x-kora-client-ip-signature")?.trim() ?? "";
    if (secret.length < 32 || isIP(ip) === 0 || !/^[a-f0-9]{64}$/i.test(signature)) {
      throw new RateLimitUnavailableError("Trusted client IP headers are missing or invalid.");
    }
    const expected = createHmac("sha256", secret).update(ip).digest();
    const presented = Buffer.from(signature, "hex");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new RateLimitUnavailableError("Trusted client IP signature is invalid.");
    }
    return ip;
  }

  const candidate = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")?.trim()
    ?? "127.0.0.1";
  return isIP(candidate) ? candidate : "127.0.0.1";
}

async function increment(shared: RedisClientType | null, key: string, windowSeconds: number) {
  if (shared) {
    const count = await shared.incr(key);
    if (count === 1) await shared.expire(key, windowSeconds);
    return { count, retryAfter: Math.max(1, await shared.ttl(key)) };
  }
  const now = Date.now();
  let bucket = memory.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    bucket = { count: 0, expiresAt: now + windowSeconds * 1000 };
    memory.set(key, bucket);
  }
  bucket.count += 1;
  return { count: bucket.count, retryAfter: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)) };
}

export async function isRateLimited(request: Request, action: string, maximum: number, windowSeconds: number, subject?: string) {
  const ip = getRateLimitClientIp(request);
  const shared = await redis();
  const keys = [`kora:rate:${action}:ip:${ip}`];
  const normalizedSubject = subject?.trim().toLowerCase();
  if (normalizedSubject) {
    const digest = createHash("sha256").update(normalizedSubject).digest("hex");
    keys.push(`kora:rate:${action}:subject:${digest}`);
  }
  let limited = false;
  let retryAfter = 1;
  try {
    for (const key of keys) {
      const bucket = await increment(shared, key, windowSeconds);
      if (bucket.count > maximum) { limited = true; retryAfter = Math.max(retryAfter, bucket.retryAfter); }
    }
  } catch {
    if (process.env.NODE_ENV === "production") throw new RateLimitUnavailableError();
    for (const key of keys) {
      const bucket = await increment(null, key, windowSeconds);
      if (bucket.count > maximum) { limited = true; retryAfter = Math.max(retryAfter, bucket.retryAfter); }
    }
  }
  return { limited, retryAfter };
}
