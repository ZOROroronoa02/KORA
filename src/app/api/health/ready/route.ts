import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isServiceReady, probeRedis, redisDependencyState } from "@/lib/health/readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const database = await prisma.$queryRaw`SELECT 1`.then(() => true, () => false);
  const redisUrl = process.env.REDIS_URL;
  const configured = Boolean(redisUrl);
  let redis = redisDependencyState({ configured, healthy: false, production: process.env.NODE_ENV === "production" });
  if (redisUrl) {
    redis = redisDependencyState({ configured: true, healthy: await probeRedis(redisUrl), production: process.env.NODE_ENV === "production" });
  }
  const ready = isServiceReady(database, redis);
  return NextResponse.json({
    name: "KORA",
    status: ready ? "ready" : "not_ready",
    database: database ? "ready" : "unavailable",
    redis,
  }, { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } });
}
