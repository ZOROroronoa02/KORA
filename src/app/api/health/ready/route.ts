import { NextResponse } from "next/server";
import { createClient } from "redis";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const database = await prisma.$queryRaw`SELECT 1`.then(() => "ok" as const, () => "unavailable" as const);
  let redis: "ok" | "optional" | "unavailable" = "optional";
  if (process.env.REDIS_URL) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", () => undefined);
    try { await client.connect(); await client.ping(); redis = "ok"; }
    catch { redis = "unavailable"; }
    finally { if (client.isOpen) await client.quit().catch(() => undefined); }
  }
  const ready = database === "ok" && (redis === "ok" || (redis === "optional" && process.env.NODE_ENV !== "production"));
  return NextResponse.json({ name: "KORA", status: ready ? "ready" : "not_ready", dependencies: { database, redis }, timestamp: new Date().toISOString() }, { status: ready ? 200 : 503 });
}
