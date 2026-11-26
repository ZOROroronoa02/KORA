import { NextRequest, NextResponse } from "next/server";
import { requirePermission, invalidateOutletPermissionCache, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { allPermissionKeys, permissionDescriptions } from "@/lib/permissions";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";

function responseError(error: unknown) {
  if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
  return NextResponse.json({ error: "Could not update role permissions." }, { status: 500 });
}

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const access = await requirePermission(request, outletId, "roles.manage");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const [roles, permissions] = await Promise.all([
    prisma.role.findMany({
      where: { tenantId: access.tenantId, OR: [{ outletId: null }, { outletId }] },
      include: { permissions: { include: { permission: true } }, assignments: { where: { outletId }, select: { userId: true } } },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    }),
    prisma.permission.findMany({ orderBy: { key: "asc" } }),
  ]);
  return NextResponse.json({
    roles: roles.map((role) => ({ id: role.id, name: role.name, description: role.description, isSystem: role.isSystem, outletId: role.outletId, permissions: role.permissions.map((entry) => entry.permission.key), assignedUserCount: new Set(role.assignments.map((assignment) => assignment.userId)).size })),
    permissions,
  });
}

async function POSTHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const access = await requirePermission(request, outletId, "roles.manage");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    const sourceRoleId = typeof body.sourceRoleId === "string" ? body.sourceRoleId : "";
    if (name.length < 2 || !sourceRoleId) return NextResponse.json({ error: "Provide a role name and system role to clone." }, { status: 400 });
    const source = await prisma.role.findFirst({ where: { id: sourceRoleId, tenantId: access.tenantId, isSystem: true }, include: { permissions: true } });
    if (!source) return NextResponse.json({ error: "System role not found." }, { status: 404 });
    const role = await prisma.$transaction(async (tx) => {
      const created = await tx.role.create({ data: { tenantId: access.tenantId, outletId, name, description: `Cloned from ${source.name}`, isSystem: false } });
      if (source.permissions.length) await tx.rolePermission.createMany({ data: source.permissions.map((entry) => ({ roleId: created.id, permissionId: entry.permissionId })) });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "ROLE_CREATED", entityType: "Role", entityId: created.id, after: { name, clonedFrom: source.name, permissionCount: source.permissions.length } } });
      return created;
    });
    return NextResponse.json({ role: { id: role.id, name: role.name, description: role.description, isSystem: role.isSystem, permissions: source.permissions.map((entry) => entry.permissionId) } }, { status: 201 });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return NextResponse.json({ error: "A role with that name already exists." }, { status: 409 });
    return responseError(error);
  }
}

async function PATCHHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const roleId = typeof body.roleId === "string" ? body.roleId : "";
    const requested = Array.isArray(body.permissions) ? body.permissions : null;
    const access = await requirePermission(request, outletId, "roles.manage");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    if (!roleId || !requested || requested.some((key) => typeof key !== "string" || !(key in permissionDescriptions))) return NextResponse.json({ error: "Provide a role and known permission keys." }, { status: 400 });
    const role = await prisma.role.findFirst({ where: { id: roleId, tenantId: access.tenantId, outletId }, include: { permissions: { include: { permission: true } } } });
    if (!role) return NextResponse.json({ error: "Role not found in this outlet." }, { status: 404 });
    if (role.isSystem) return NextResponse.json({ error: "System role permissions are locked. Clone the role to customize it." }, { status: 409 });
    const nextKeys = [...new Set(requested as string[])];
    const actorRoles = await prisma.userOutletRole.findMany({ where: { userId: access.user.id, outletId }, include: { role: { include: { permissions: { include: { permission: true } } } } } });
    const actorKeepsRoleAdmin = actorRoles.some((assignment) => assignment.roleId !== roleId && assignment.role.permissions.some((entry) => entry.permission.key === "roles.manage")) || nextKeys.includes("roles.manage");
    if (!actorKeepsRoleAdmin) return NextResponse.json({ error: "Keep roles.manage on at least one of your outlet roles to avoid locking yourself out." }, { status: 409 });
    const permissionRows = await prisma.permission.findMany({ where: { key: { in: nextKeys } } });
    if (permissionRows.length !== nextKeys.length) return NextResponse.json({ error: "One or more permissions are unknown." }, { status: 400 });
    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      if (permissionRows.length) await tx.rolePermission.createMany({ data: permissionRows.map((permission) => ({ roleId, permissionId: permission.id })) });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "ROLE_PERMISSIONS_CHANGED", entityType: "Role", entityId: roleId, before: { permissions: role.permissions.map((entry) => entry.permission.key) }, after: { permissions: nextKeys } } });
    });
    await invalidateOutletPermissionCache(outletId);
    return NextResponse.json({ ok: true, permissions: nextKeys.sort(), knownPermissionCount: allPermissionKeys.length });
  } catch (error) { return responseError(error); }
}

export const GET = withTenantScope(GETHandler);
export const POST = withTenantScope(POSTHandler);
export const PATCH = withTenantScope(PATCHHandler);
