import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const [assignments, platformAssignments] = await Promise.all([
    prisma.userOutletRole.findMany({ where: { userId: user.id, outlet: { tenantId: user.tenantId } }, include: { outlet: true, role: { include: { permissions: { include: { permission: true } } } } } }),
    prisma.userPlatformRole.findMany({ where: { userId: user.id, role: { isSystem: true, name: "SUPER_ADMIN", tenantId: null } }, include: { role: { include: { permissions: { include: { permission: true } } } } } }),
  ]);
  const isPlatformAdmin = platformAssignments.length > 0;
  const outletRows = isPlatformAdmin
    ? await prisma.outlet.findMany({ orderBy: [{ tenantId: "asc" }, { name: "asc" }], take: 500, select: { id: true, name: true, tenantId: true } })
    : [...new Map(assignments.map((assignment) => [assignment.outlet.id, assignment.outlet])).values()];
  const platformPermissions = platformAssignments.flatMap((assignment) => assignment.role.permissions.map((entry) => entry.permission.key));
  const outlets = outletRows.map((outlet) => {
    const outletAssignments = assignments.filter((assignment) => assignment.outletId === outlet.id && assignment.role.tenantId === outlet.tenantId && (!assignment.role.outletId || assignment.role.outletId === outlet.id));
    const roleNames = outletAssignments.map((assignment) => assignment.role.name);
    if (isPlatformAdmin) roleNames.push("SUPER_ADMIN");
    return {
      id: outlet.id,
      name: outlet.name,
      role: roleNames[0] ?? "SUPER_ADMIN",
      roleIds: outletAssignments.map((assignment) => assignment.roleId),
      roles: roleNames,
      permissions: [...new Set([...platformPermissions, ...outletAssignments.flatMap((assignment) => assignment.role.permissions.map((entry) => entry.permission.key))])].sort(),
    };
  });
  return NextResponse.json({ user, outlets, isPlatformAdmin });
}
