import { NextRequest, NextResponse } from "next/server";
import { requirePermission, invalidateOutletPermissionCache } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const access = await requirePermission(request, outletId, "staff.manage");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const assignments = await prisma.userOutletRole.findMany({
    where: { outletId, user: { tenantId: access.tenantId } },
    include: { user: { select: { id: true, name: true, email: true, active: true, approvalPinHash: true } }, role: { include: { permissions: { include: { permission: true } } } } },
    orderBy: [{ user: { name: "asc" } }, { role: { name: "asc" } }],
  });
  const byUser = new Map<string, { user: { id: string; name: string; email: string; active: boolean; hasApprovalPin: boolean }; roles: Array<{ id: string; name: string }>; permissions: Set<string> }>();
  for (const assignment of assignments) {
    if (assignment.role.tenantId !== access.tenantId || (assignment.role.outletId && assignment.role.outletId !== outletId)) continue;
    const current = byUser.get(assignment.userId) ?? {
      user: { id: assignment.user.id, name: assignment.user.name, email: assignment.user.email, active: assignment.user.active, hasApprovalPin: Boolean(assignment.user.approvalPinHash) },
      roles: [], permissions: new Set<string>(),
    };
    current.roles.push({ id: assignment.role.id, name: assignment.role.name });
    for (const entry of assignment.role.permissions) current.permissions.add(entry.permission.key);
    byUser.set(assignment.userId, current);
  }
  return NextResponse.json({ staff: [...byUser.values()].map((item) => ({ ...item, permissions: [...item.permissions].sort() })) });
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const userId = typeof body.userId === "string" ? body.userId : "";
    const roleIds = Array.isArray(body.roleIds) ? [...new Set(body.roleIds.filter((id): id is string => typeof id === "string"))] : null;
    const access = await requirePermission(request, outletId, "roles.manage");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    if (!userId || !roleIds || roleIds.length < 1 || roleIds.length > 10) return NextResponse.json({ error: "Select between 1 and 10 outlet roles." }, { status: 400 });
    const [target, outlet, roles, previous] = await Promise.all([
      prisma.user.findFirst({ where: { id: userId, tenantId: access.tenantId, active: true }, select: { id: true } }),
      prisma.outlet.findFirst({ where: { id: outletId, tenantId: access.tenantId }, select: { id: true } }),
      prisma.role.findMany({ where: { id: { in: roleIds }, tenantId: access.tenantId, OR: [{ outletId: null }, { outletId }] }, include: { permissions: { include: { permission: true } } } }),
      prisma.userOutletRole.findMany({ where: { userId, outletId }, include: { role: { include: { permissions: { include: { permission: true } } } } } }),
    ]);
    if (!target || !outlet || roles.length !== roleIds.length) return NextResponse.json({ error: "User, outlet, or one of the selected roles is outside your tenant." }, { status: 404 });
    if (userId === access.user.id && !roles.some((role) => role.permissions.some((entry) => entry.permission.key === "roles.manage"))) return NextResponse.json({ error: "Keep roles.manage on your own account to avoid locking yourself out." }, { status: 409 });
    await prisma.$transaction(async (tx) => {
      await tx.userOutletRole.deleteMany({ where: { userId, outletId } });
      await tx.userOutletRole.createMany({ data: roleIds.map((roleId) => ({ userId, outletId, roleId })) });
      await tx.auditLog.create({ data: {
        tenantId: access.tenantId, outletId, userId: access.user.id, action: "USER_ROLES_CHANGED", entityType: "User", entityId: userId,
        before: { roles: previous.map((assignment) => ({ id: assignment.roleId, name: assignment.role.name })) },
        after: { roles: roles.map((role) => ({ id: role.id, name: role.name })) },
      } });
    });
    await invalidateOutletPermissionCache(outletId, [userId]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    return NextResponse.json({ error: "Could not assign outlet roles." }, { status: 500 });
  }
}
