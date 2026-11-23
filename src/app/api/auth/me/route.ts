import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const assignments = await prisma.userOutletRole.findMany({ where: { userId: user.id }, include: { outlet: true, role: { include: { permissions: { include: { permission: true } } } } } });
  return NextResponse.json({ user, outlets: assignments.map((a) => ({ id: a.outlet.id, name: a.outlet.name, role: a.role.name, permissions: a.role.permissions.map((p) => p.permission.key) })) });
}
