import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    name: "KORA",
    status: "live",
    checks: {
      liveness: "/api/health/live",
      readiness: "/api/health/ready",
    },
    timestamp: new Date().toISOString(),
  });
}
