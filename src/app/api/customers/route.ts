import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";

function normalizePhone(value: string) {
  const phone = value.replace(/[\s()-]/g, "");
  return /^\+?[0-9]{8,15}$/.test(phone) ? phone : "";
}

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const access = await requirePermission(request, outletId, "customers.view");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const customers = await prisma.customer.findMany({
    where: { tenantId: access.tenantId, outletLinks: { some: { outletId } } },
    include: { outletLinks: { where: { outletId } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return NextResponse.json(customers.map(({ outletLinks, ...customer }) => ({
    ...customer,
    phone: `••••••${customer.phone.slice(-4)}`,
    outlet: outletLinks[0] ? { ...outletLinks[0], spendPaise: outletLinks[0].spendPaise.toString() } : null,
  })));
}

async function POSTHandler(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await readJsonObject(request); }
  catch (error) { return NextResponse.json({ error: error instanceof RequestInputError ? error.message : "Invalid request body." }, { status: error instanceof RequestInputError ? error.statusCode : 400 }); }
  const outletId = typeof body.outletId === "string" ? body.outletId : "";
  const access = await requirePermission(request, outletId, "customers.manage");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : "";
  if (!phone) return NextResponse.json({ error: "Provide a valid mobile number." }, { status: 400 });
  const outlet = await prisma.outlet.findFirst({ where: { id: outletId, tenantId: access.tenantId } });
  if (!outlet) return NextResponse.json({ error: "Outlet not found." }, { status: 404 });

  const customer = await prisma.customer.upsert({
    where: { tenantId_phone: { tenantId: access.tenantId, phone } },
    update: name ? { name } : {},
    create: { tenantId: access.tenantId, phone, name: name || null },
  });
  await prisma.customerOutlet.upsert({
    where: { customerId_outletId: { customerId: customer.id, outletId } },
    // Creating a CRM profile is not a visit. Visits and spend are recorded from
    // completed orders, so retrying this upsert cannot inflate customer metrics.
    update: {},
    create: { customerId: customer.id, outletId },
  });
  return NextResponse.json({ id: customer.id, name: customer.name, phone: `••••••${customer.phone.slice(-4)}` }, { status: 201 });
}

export const GET = withTenantScope(GETHandler);
export const POST = withTenantScope(POSTHandler);
