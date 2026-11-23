import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clearRefreshCookie, hashToken, readRefreshCookie } from "@/lib/server-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const token = readRefreshCookie(request);
  if (token) await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
  const response = NextResponse.json({ ok: true });
  response.headers.set("set-cookie", clearRefreshCookie()); return response;
}
