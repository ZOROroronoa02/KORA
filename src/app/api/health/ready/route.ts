import { NextResponse } from "next/server";
import { createClient } from "redis";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const database = await prisma.$queryRaw`SELECT 1`.then(() => true, () => false);
  let redisReady = process.env.REDIS_URL ? false : process.env.NODE_ENV !== "production";
  if (process.env.REDIS_URL) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", () => undefined);
    try { await client.connect(); await client.ping(); redisReady = true; }
    catch { redisReady = false; }
    finally { if (client.isOpen) await client.quit().catch(() => undefined); }
  }
  const ready = database && redisReady;
  return NextResponse.json({ name: "KORA", status: ready ? "ready" : "not_ready" }, { status: ready ? 200 : 503 });
}
