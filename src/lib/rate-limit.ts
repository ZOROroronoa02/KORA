import { createClient, type RedisClientType } from "redis";

type Bucket = { count: number; expiresAt: number };
const memory = new Map<string, Bucket>();
let client: RedisClientType | undefined;
let clientReady: Promise<RedisClientType> | undefined;

async function redis() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on("error", () => undefined);
    clientReady = client.connect().then(() => client!);
  }
  return clientReady;
}

export async function isRateLimited(request: Request, action: string, maximum: number, windowSeconds: number) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const key = `kora:rate:${action}:${ip}`;
  const shared = await redis();
  if (shared) {
    const count = await shared.incr(key);
    if (count === 1) await shared.expire(key, windowSeconds);
    const ttl = await shared.ttl(key);
    return { limited: count > maximum, retryAfter: Math.max(1, ttl) };
  }
  if (process.env.NODE_ENV === "production") throw new Error("REDIS_URL is required for production API rate limits");
  const now = Date.now();
  let bucket = memory.get(key);
  if (!bucket || bucket.expiresAt <= now) { bucket = { count: 0, expiresAt: now + windowSeconds * 1000 }; memory.set(key, bucket); }
  bucket.count += 1;
  return { limited: bucket.count > maximum, retryAfter: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)) };
}
