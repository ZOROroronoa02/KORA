import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { accessTokenSeconds, clearRefreshCookie, createAccessToken, hashToken, newRefreshToken, readRefreshCookie, refreshCookie } from "@/lib/server-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Cross-origin request denied." }, { status: 403 });
  const presented = readRefreshCookie(request);
  if (!presented) return NextResponse.json({ error: "Refresh session required." }, { status: 401 });
  try {
    const saved = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(presented) }, include: { user: true } });
    if (!saved || saved.revokedAt || saved.expiresAt <= new Date() || !saved.user.active) {
      const response = NextResponse.json({ error: "Refresh session expired. Sign in again." }, { status: 401 });
      response.headers.set("set-cookie", clearRefreshCookie()); return response;
    }
    const accessToken = await createAccessToken(saved.user);
    const next = newRefreshToken();
    const created = await prisma.$transaction(async (tx) => {
      const replacement = await tx.refreshToken.create({ data: { userId: saved.userId, tokenHash: hashToken(next), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
      const rotated = await tx.refreshToken.updateMany({ where: { id: saved.id, revokedAt: null, expiresAt: { gt: new Date() } }, data: { revokedAt: new Date(), replacedById: replacement.id } });
      if (rotated.count !== 1) throw new Error("Refresh token was already rotated");
      return replacement;
    });
    const response = NextResponse.json({ accessToken, expiresIn: accessTokenSeconds });
    response.headers.set("set-cookie", refreshCookie(next, 30 * 24 * 60 * 60)); return response;
  } catch (error) {
    if (error instanceof Error && error.message.includes("JWT_ACCESS_SECRET")) return NextResponse.json({ error: "Session refresh is temporarily unavailable." }, { status: 503 });
    return NextResponse.json({ error: "Could not refresh session." }, { status: 500 });
  }
}
