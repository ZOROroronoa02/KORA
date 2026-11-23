import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    name: "KORA",
    status: "alive",
    mode: "local-demo",
    persistence: "browser-local-storage",
    readiness: "/api/health/ready",
    timestamp: new Date().toISOString(),
  });
}
