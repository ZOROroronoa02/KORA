"use client";

import { useState } from "react";
import type { CachedDisplayOrder } from "@/lib/pos-offline";

type OfflinePrintMode = "receipt" | "kot";

function formatPaise(value: number) {
  const paise = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return `₹${Math.floor(paise / 100).toLocaleString("en-IN")}.${String(paise % 100).padStart(2, "0")}`;
}

export function OfflinePrintDocument({ order, outletName, mode, onClose }: {
  order: CachedDisplayOrder;
  outletName: string;
  mode: OfflinePrintMode;
  onClose: () => void;
}) {
  const [width, setWidth] = useState<58 | 80>(80);
  const estimate = order.provisionalEstimate;
  const totalPaise = estimate?.totalPaise ?? Math.max(0, Math.round(order.total * 100));
  const paidPaise = estimate?.paidPaise ?? Math.max(0, Math.round((order.paidAmount ?? 0) * 100));
  const printedAt = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
  }).format(new Date(estimate?.createdAt ?? Date.now()));
  const title = mode === "receipt" ? "PROVISIONAL RECEIPT" : "OFFLINE KITCHEN TICKET";

  return <div className="invoice-print-root" role="dialog" aria-modal="true" aria-label={`${title} preview`}>
    <div className="invoice-preview-toolbar screen-only">
      <div><b>{title}</b><small>{order.id} · waiting for sync</small></div>
      <label>Paper width<select value={width} onChange={(event) => setWidth(Number(event.target.value) as 58 | 80)}><option value={58}>58 mm</option><option value={80}>80 mm</option></select></label>
      <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      <button type="button" className="primary-button" onClick={() => window.print()}>Print</button>
    </div>
    <article className={`invoice-paper invoice-paper-${width} offline-print-paper`}>
      <header className="invoice-heading">
        <strong>{outletName}</strong>
        <span>{mode === "receipt" ? "CUSTOMER COPY" : "KITCHEN COPY"}</span>
      </header>
      <div className="invoice-rule" />
      <h1>{title}</h1>
      <p className="offline-print-warning">
        {mode === "receipt" ? "NOT A GST TAX INVOICE · FINAL BILL AFTER SYNC" : "NOT SYNCED · SERVER KOT NUMBER PENDING"}
      </p>
      <div className="invoice-meta">
        <span>Offline reference</span><b>{order.id}</b>
        <span>Created</span><b>{printedAt}</b>
        <span>Order type</span><b>{order.type}{order.table !== "—" ? ` · Table ${order.table}` : ""}</b>
        {mode === "receipt" && order.customer && <><span>Customer</span><b>{order.customer}</b></>}
      </div>
      <div className="invoice-rule" />
      <div className="offline-print-lines">
        {order.items.map((item) => <div className="offline-print-line" key={item.id}>
          <span><b>{item.qty} × {item.name}</b>{mode === "kot" && item.note && <small>{item.note}</small>}</span>
          {mode === "receipt" && <b>{formatPaise(Math.round(item.price * 100) * item.qty)}</b>}
        </div>)}
      </div>
      {mode === "receipt" && <>
        <div className="invoice-rule" />
        <div className="invoice-totals">
          {estimate && <>
            <div><span>Estimated subtotal</span><b>{formatPaise(estimate.subtotalPaise)}</b></div>
            {estimate.discountPaise > 0 && <div><span>Estimated discount</span><b>−{formatPaise(estimate.discountPaise)}</b></div>}
            {estimate.serviceChargePaise > 0 && <div><span>Estimated service charge</span><b>{formatPaise(estimate.serviceChargePaise)}</b></div>}
            {estimate.taxPaise > 0 && <div><span>Estimated tax</span><b>{formatPaise(estimate.taxPaise)}</b></div>}
          </>}
          <div className="invoice-total"><span>Estimated amount</span><b>{formatPaise(totalPaise)}</b></div>
          <div><span>{paidPaise > 0 ? `Recorded locally · ${estimate?.paymentMethod ?? order.payment}` : "Payment pending"}</span><b>{formatPaise(paidPaise)}</b></div>
          <div className="invoice-due"><span>Estimated balance</span><b>{formatPaise(Math.max(0, totalPaise - paidPaise))}</b></div>
        </div>
        <p className="offline-print-footer">The amount and tax are provisional and may change when KORA verifies current menu and tax settings. Keep this receipt. KORA will issue the final bill and applicable tax document after synchronization. A payment marked here was recorded on this device; it does not confirm a payment gateway settlement.</p>
      </>}
      {mode === "kot" && <p className="offline-print-footer">This order was recorded offline. The server kitchen ticket will be created after synchronization. Confirm preparation with the kitchen team.</p>}
    </article>
  </div>;
}
