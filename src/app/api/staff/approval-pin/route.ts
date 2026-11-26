import { NextRequest, NextResponse } from "next/server";
import { hash, compare } from "bcryptjs";
import { authorizeAnyOutletPermission } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const pin = typeof body.pin === "string" ? body.pin : "";
    const access = await authorizeAnyOutletPermission(request, outletId, ["bills.discount.approve", "bills.void"]);
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    if (!/^\d{4,8}$/.test(pin)) return NextResponse.json({ error: "PIN must contain 4 to 8 digits." }, { status: 400 });
    const user = await prisma.user.findFirst({ where: { id: access.user.id, tenantId: access.tenantId, active: true }, select: { approvalPinHash: true } });
    const currentPin = typeof body.currentPin === "string" ? body.currentPin : "";
    if (user?.approvalPinHash && (!currentPin || !(await compare(currentPin, user.approvalPinHash)))) return NextResponse.json({ error: "Current approval PIN is incorrect." }, { status: 403 });
    const approvalPinHash = await hash(pin, 12);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: access.user.id }, data: { approvalPinHash } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "APPROVAL_PIN_UPDATED", entityType: "User", entityId: access.user.id } });
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    return NextResponse.json({ error: "Could not update approval PIN." }, { status: 500 });
  }
}
