import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ name: "KORA", status: "live", timestamp: new Date().toISOString() });
}
