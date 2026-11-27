"use client";

import { useState } from "react";
import { gstStateCodeForName } from "@/lib/domain/gst-profile";

type InvoiceLine = {
  name: string;
  quantity: number;
  unitPricePaise: string;
  discountPaise: string;
  taxablePaise: number;
  serviceChargePaise: number;
  gstBps: number;
  taxPaise: number;
  totalPaise: number;
  taxCodeKind: "HSN" | "SAC" | null;
  taxCode: string | null;
};

type TaxGroup = { taxCodeKind: string | null; taxCode: string | null; gstBps: number; taxablePaise: number; taxPaise: number; cgstPaise: string; sgstPaise: string; igstPaise: string };
type InvoiceAddress = { line1: string; line2?: string; city: string; state: string; pincode: string };

export type InvoicePrintData = {
  id: string;
  documentType: "RECEIPT" | "TAX_INVOICE" | "BILL_OF_SUPPLY";
  gstProfile: string;
  invoiceNumber: string;
  issuedAt: string;
  outletName: string;
  fssaiLicense: string | null;
  supplierName: string;
  supplierGstin: string | null;
  supplierAddress: InvoiceAddress | null;
  placeOfSupply: string | null;
  recipientName: string | null;
  recipientGstin: string | null;
  recipientAddress: InvoiceAddress | null;
  orderNumber: number;
  orderType: string;
  tableLabel: string | null;
  lines: InvoiceLine[];
  totals: { subtotalPaise: string; discountPaise: string; serviceChargePaise: string; taxablePaise: string; cgstPaise: string; sgstPaise: string; igstPaise: string; totalTaxPaise: string; totalPaise: string; paidPaise: string; duePaise: string };
  taxBreakdown: TaxGroup[];
  paymentMethods: string[];
};

function rupees(value: string | number) {
  const paise = BigInt(value);
  const whole = (paise / 100n).toLocaleString("en-IN");
  const fraction = String(paise % 100n).padStart(2, "0");
  return `₹${whole}.${fraction}`;
}

function percentage(bps: number) {
  return `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;
}

function addressLines(address: InvoiceAddress | null) {
  if (!address) return [];
  const state = address.state ? `${address.state}${gstStateCodeForName(address.state) ? ` (${gstStateCodeForName(address.state)})` : ""}` : "";
  return [address.line1, address.line2, [address.city, state, address.pincode].filter(Boolean).join(", ")].filter(Boolean);
}

export function InvoicePrintDocument({ document, onClose }: { document: InvoicePrintData; onClose: () => void }) {
  const [width, setWidth] = useState<58 | 80>(80);
  const issued = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(document.issuedAt));
  const title = document.documentType === "TAX_INVOICE" ? "TAX INVOICE" : document.documentType === "BILL_OF_SUPPLY" ? "BILL OF SUPPLY" : "RECEIPT";

  return <div className="invoice-print-root" role="dialog" aria-modal="true" aria-label={`${title} preview`}>
    <div className="invoice-preview-toolbar screen-only">
      <div><b>{title}</b><small>{document.invoiceNumber} · India time</small></div>
      <label>Paper width<select value={width} onChange={(event) => setWidth(Number(event.target.value) as 58 | 80)}><option value={58}>58 mm</option><option value={80}>80 mm</option></select></label>
      <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      <button type="button" className="primary-button" onClick={() => window.print()}>Print document</button>
    </div>
    <article className={`invoice-paper invoice-paper-${width}`}>
      {document.documentType === "BILL_OF_SUPPLY" && <p className="invoice-composition-note">Composition taxable person, not eligible to collect tax on supplies</p>}
      <header className="invoice-heading">
        <strong>{document.supplierName}</strong>
        <span>{document.outletName}</span>
        {addressLines(document.supplierAddress).map((line, index) => <span key={index}>{line}</span>)}
        {document.supplierGstin && <span>GSTIN: {document.supplierGstin}</span>}
        {document.fssaiLicense && <span>FSSAI: {document.fssaiLicense}</span>}
      </header>
      <div className="invoice-rule" />
      <h1>{title}</h1>
      <div className="invoice-meta"><span>Invoice no.</span><b>{document.invoiceNumber}</b><span>Issued</span><b>{issued}</b><span>Order</span><b>#{document.orderNumber} · {document.orderType.replaceAll("_", " ")}{document.tableLabel ? ` · Table ${document.tableLabel}` : ""}</b></div>
      {(document.recipientName || document.recipientGstin || document.recipientAddress) && <section className="invoice-parties">
        <b>Bill to</b>
        {document.recipientName && <span>{document.recipientName}</span>}
        {document.recipientGstin && <span>GSTIN: {document.recipientGstin}</span>}
        {addressLines(document.recipientAddress).map((line, index) => <span key={index}>{line}</span>)}
      </section>}
      {document.placeOfSupply && <p className="invoice-place">Place of supply: {document.placeOfSupply}{gstStateCodeForName(document.placeOfSupply) ? ` (${gstStateCodeForName(document.placeOfSupply)})` : ""}</p>}
      <div className="invoice-rule" />
      <section className="invoice-items">
        {document.lines.map((line, index) => <div className="invoice-item" key={`${line.name}-${index}`}>
          <div className="invoice-item-title"><b>{line.name}</b><b>{rupees(line.totalPaise)}</b></div>
          <span>{line.quantity} × {rupees(line.unitPricePaise)}{line.taxCode && ` · ${line.taxCodeKind} ${line.taxCode}`}</span>
          {BigInt(line.discountPaise) > 0n && <span>Discount: −{rupees(line.discountPaise)}</span>}
          <span>Taxable {rupees(line.taxablePaise)} · GST {percentage(line.gstBps)} · tax {rupees(line.taxPaise)}</span>
        </div>)}
      </section>
      <div className="invoice-rule" />
      <section className="invoice-totals">
        <div><span>Subtotal</span><b>{rupees(document.totals.subtotalPaise)}</b></div>
        {BigInt(document.totals.discountPaise) > 0n && <div><span>Discount</span><b>−{rupees(document.totals.discountPaise)}</b></div>}
        {BigInt(document.totals.serviceChargePaise) > 0n && <div><span>Service charge</span><b>{rupees(document.totals.serviceChargePaise)}</b></div>}
        <div><span>Taxable value</span><b>{rupees(document.totals.taxablePaise)}</b></div>
        {document.taxBreakdown.map((group, index) => <div className="invoice-tax-group" key={`${group.taxCodeKind}-${group.taxCode}-${group.gstBps}-${index}`}>
          <span>{group.taxCodeKind && group.taxCode ? `${group.taxCodeKind} ${group.taxCode} · ` : ""}{percentage(group.gstBps)} · taxable {rupees(group.taxablePaise)}</span>
          <small>{BigInt(group.cgstPaise) > 0n && `CGST ${percentage(Math.floor(group.gstBps / 2))} ${rupees(group.cgstPaise)} · `}{BigInt(group.sgstPaise) > 0n && `SGST ${percentage(Math.ceil(group.gstBps / 2))} ${rupees(group.sgstPaise)} · `}{BigInt(group.igstPaise) > 0n && `IGST ${percentage(group.gstBps)} ${rupees(group.igstPaise)}`}{BigInt(group.taxPaise) === 0n && "No GST charged"}</small>
        </div>)}
        <div className="invoice-total"><span>Total</span><b>{rupees(document.totals.totalPaise)}</b></div>
        {BigInt(document.totals.paidPaise) > 0n && <div><span>Paid{document.paymentMethods.length ? ` · ${document.paymentMethods.join(", ")}` : ""}</span><b>{rupees(document.totals.paidPaise)}</b></div>}
        {BigInt(document.totals.duePaise) > 0n && <div className="invoice-due"><span>Balance due</span><b>{rupees(document.totals.duePaise)}</b></div>}
      </section>
      <div className="invoice-rule" />
      <footer className="invoice-footer"><span>Thank you for dining with us.</span><span>Computer-generated document</span><span>Authorized representative ____________________</span></footer>
    </article>
  </div>;
}
