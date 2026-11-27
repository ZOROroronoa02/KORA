import { NextRequest, NextResponse } from "next/server";
import { authorizeAnyOutletPermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { allocatePaise, calculateSaleBreakdown } from "@/lib/billing";
import { gstProfileDefaults, hasInvoiceAddress, isValidGstin, validateRecipientInvoiceDetails, validateTaxCode } from "@/lib/domain/gst-profile";

export const runtime = "nodejs";

const jsonSafe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

function safePaise(value: bigint, label: string) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} is outside the supported range.`);
  return Number(value);
}

async function GETHandler(request: NextRequest, context: { params: Promise<{ billId: string }> }) {
  const { billId } = await context.params;
  const outletId = request.nextUrl.searchParams.get("outletId")?.trim() ?? "";
  if (!outletId || !billId || billId.length > 80) return NextResponse.json({ error: "A valid bill and outlet are required." }, { status: 400 });
  const access = await authorizeAnyOutletPermission(request, outletId, ["bills.settle", "reports.view.financial"]);
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });

  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId: access.tenantId, outletId },
    include: {
      order: { include: { items: { orderBy: { id: "asc" } }, table: { select: { label: true } }, customer: { select: { name: true } } } },
      outlet: { select: { name: true, fssaiLicense: true } },
      payments: { where: { status: "PAID" }, include: { reversals: true }, orderBy: { recordedAt: "asc" } },
    },
  });
  if (!bill) return NextResponse.json({ error: "Bill not found in this outlet." }, { status: 404 });

  try {
    const taxDocument = bill.documentType !== "RECEIPT";
    if (taxDocument && bill.invoiceNumber.length > 16) return NextResponse.json({ error: "This historical bill number exceeds the GST document serial limit. Do not alter an issued number; ask the owner/accountant to review it." }, { status: 409 });
    if (taxDocument && (!bill.gstinSnapshot || !isValidGstin(bill.gstinSnapshot) || !hasInvoiceAddress(bill.supplierAddressSnapshot))) {
      return NextResponse.json({ error: "This bill is missing the supplier GSTIN or address snapshot required for a GST document. Review it with the owner before printing." }, { status: 409 });
    }
    if (taxDocument && !bill.placeOfSupplySnapshot) return NextResponse.json({ error: "This bill is missing its place-of-supply state snapshot." }, { status: 409 });
    const recipientCheck = validateRecipientInvoiceDetails({
      name: bill.recipientNameSnapshot ?? bill.order.customer?.name,
      gstin: bill.recipientGstinSnapshot,
      address: bill.recipientAddressSnapshot,
    }, bill.documentType === "TAX_INVOICE" ? safePaise(bill.taxablePaise, "Bill taxable value") : 0);
    if (recipientCheck.error) {
      return NextResponse.json({ error: `This bill has incomplete buyer details and cannot be printed: ${recipientCheck.error}` }, { status: 409 });
    }
    if (bill.documentType === "TAX_INVOICE" && bill.order.items.some((item) => !item.taxCodeKindSnapshot || !item.taxCodeSnapshot || validateTaxCode({ kind: item.taxCodeKindSnapshot, code: item.taxCodeSnapshot }) !== null)) {
      return NextResponse.json({ error: "This bill is missing a valid HSN/SAC snapshot on one or more lines. Update the menu mapping; existing bills cannot be silently rewritten." }, { status: 409 });
    }

    const lines = bill.order.items.map((item) => ({
      quantity: item.quantity,
      unitPricePaise: safePaise(item.unitPricePaise, "Line price"),
      gstBps: item.gstBps,
      discountPaise: safePaise(item.discountPaise, "Line discount"),
    }));
    const breakdown = calculateSaleBreakdown(lines, { serviceChargeBps: bill.serviceChargeBpsSnapshot });
    const totalTaxPaise = safePaise(bill.cgstPaise + bill.sgstPaise + bill.igstPaise, "Bill tax");
    if (breakdown.subtotalPaise !== safePaise(bill.subtotalPaise, "Bill subtotal")
      || breakdown.discountPaise !== safePaise(bill.discountPaise, "Bill discount")
      || breakdown.taxablePaise !== safePaise(bill.taxablePaise, "Bill taxable value")
      || breakdown.serviceChargePaise !== safePaise(bill.serviceChargePaise, "Service charge")
      || breakdown.taxPaise !== totalTaxPaise
      || breakdown.totalPaise !== safePaise(bill.totalPaise, "Bill total")) {
      return NextResponse.json({ error: "Stored bill lines do not reconcile with its issued total. Contact the owner before printing." }, { status: 409 });
    }

    const groups = new Map<string, { taxCodeKind: string | null; taxCode: string | null; gstBps: number; taxablePaise: number; taxPaise: number }>();
    bill.order.items.forEach((item, index) => {
      const line = breakdown.lines[index];
      const key = `${item.taxCodeKindSnapshot ?? ""}\u0000${item.taxCodeSnapshot ?? ""}\u0000${line.gstBps}`;
      const current = groups.get(key) ?? { taxCodeKind: item.taxCodeKindSnapshot, taxCode: item.taxCodeSnapshot, gstBps: line.gstBps, taxablePaise: 0, taxPaise: 0 };
      current.taxablePaise += line.taxablePaise;
      current.taxPaise += line.taxPaise;
      groups.set(key, current);
    });
    const taxGroups = [...groups.values()];
    const weight = taxGroups.map((group) => BigInt(group.taxPaise));
    const cgst = taxGroups.length ? allocatePaise(bill.cgstPaise, weight) : [];
    const sgst = taxGroups.length ? allocatePaise(bill.sgstPaise, weight) : [];
    const igst = taxGroups.length ? allocatePaise(bill.igstPaise, weight) : [];
    const taxBreakdown = taxGroups.map((group, index) => ({
      ...group,
      cgstPaise: cgst[index].toString(),
      sgstPaise: sgst[index].toString(),
      igstPaise: igst[index].toString(),
    }));
    const paidPaise = bill.payments.reduce((sum, payment) => sum + payment.amountPaise - payment.reversals.reduce((reversed, reversal) => reversed + reversal.amountPaise, 0n), 0n);
    const requiredDocumentType = gstProfileDefaults[bill.gstProfile].documentType;
    if (requiredDocumentType !== bill.documentType) return NextResponse.json({ error: "Bill document profile is inconsistent. Contact the owner before printing." }, { status: 409 });

    return NextResponse.json(jsonSafe({
      id: bill.id,
      documentType: bill.documentType,
      gstProfile: bill.gstProfile,
      invoiceNumber: bill.invoiceNumber,
      issuedAt: bill.issuedAt,
      outletName: bill.outlet.name,
      fssaiLicense: bill.outlet.fssaiLicense,
      supplierName: bill.supplierNameSnapshot,
      supplierGstin: bill.gstinSnapshot,
      supplierAddress: bill.supplierAddressSnapshot,
      placeOfSupply: bill.placeOfSupplySnapshot,
      recipientName: bill.recipientNameSnapshot ?? bill.order.customer?.name ?? null,
      recipientGstin: bill.recipientGstinSnapshot,
      recipientAddress: bill.recipientAddressSnapshot,
      orderNumber: bill.order.orderNumber,
      orderType: bill.order.type,
      tableLabel: bill.order.table?.label ?? null,
      lines: bill.order.items.map((item, index) => ({
        name: item.nameSnapshot,
        quantity: item.quantity,
        unitPricePaise: item.unitPricePaise,
        discountPaise: item.discountPaise,
        taxablePaise: breakdown.lines[index].taxablePaise,
        serviceChargePaise: breakdown.lines[index].serviceChargePaise,
        gstBps: breakdown.lines[index].gstBps,
        taxPaise: breakdown.lines[index].taxPaise,
        totalPaise: breakdown.lines[index].totalPaise,
        taxCodeKind: item.taxCodeKindSnapshot,
        taxCode: item.taxCodeSnapshot,
      })),
      totals: {
        subtotalPaise: bill.subtotalPaise,
        discountPaise: bill.discountPaise,
        serviceChargePaise: bill.serviceChargePaise,
        taxablePaise: bill.taxablePaise,
        cgstPaise: bill.cgstPaise,
        sgstPaise: bill.sgstPaise,
        igstPaise: bill.igstPaise,
        totalTaxPaise,
        totalPaise: bill.totalPaise,
        paidPaise,
        duePaise: bill.totalPaise > paidPaise ? bill.totalPaise - paidPaise : 0n,
      },
      taxBreakdown,
      paymentMethods: [...new Set(bill.payments.map((payment) => payment.method))],
    }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error("KORA invoice rendering data validation failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Invoice data could not be prepared." }, { status: 500 });
  }
}

export const GET = withTenantScope(GETHandler);
