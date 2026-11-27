"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Activity, AlertTriangle, ArrowRight, Box, Clock3, Package, Plus, RefreshCw, Search, ShoppingBag, Truck, Users } from "lucide-react";
import { readJson } from "@/lib/client-api";

type CloudOrder = {
  id: string;
  type: string;
  table: string;
  status: string;
  time: string;
  items: Array<{ id: string; name: string; qty: number }>;
};

type CloudCustomer = { id?: string; name: string; phone: string; visits: number; spend: number };

type CloudMaterial = {
  id: string;
  name: string;
  unit: string;
  quantityMilli: string;
  reorderMilli: string;
  costPerUnitPaise: string;
};

type CloudVendor = { id: string; name: string; phone: string | null; email: string | null; gstin: string | null; active: boolean };

export function CloudOverview({
  outletName,
  orders,
  pendingCount,
  loading,
  error,
  canCreateOrders,
  canManageTeam,
  canViewReports,
  onNavigate,
}: {
  outletName: string;
  orders: CloudOrder[];
  pendingCount: number;
  loading: boolean;
  error: string;
  canCreateOrders: boolean;
  canManageTeam: boolean;
  canViewReports: boolean;
  onNavigate: (page: "POS" | "Orders" | "Team" | "Reports") => void;
}) {
  const activeOrders = orders.filter((order) => !["Completed", "Cancelled"].includes(order.status));

  return <>
    <div className="page-title-row overview-title">
      <div>
        <p className="eyebrow">CLOUD OUTLET</p>
        <h1>Outlet activity<span className="title-period">.</span></h1>
        <p className="muted">Live order records currently loaded for {outletName}.</p>
      </div>
      {canCreateOrders && <button className="primary-button" onClick={() => onNavigate("POS")}><ShoppingBag size={16} /> New order</button>}
    </div>

    {error && <div className="cloud-data-notice" role="status"><AlertTriangle size={16} /><span>{error} Showing only records already available in this workspace.</span></div>}

    <div className="stats-grid">
      <div className="card cloud-metric"><span>Orders loaded</span><b>{orders.length}</b><small>Records returned for this outlet</small></div>
      <div className="card cloud-metric"><span>Active orders</span><b>{activeOrders.length}</b><small>Not completed or cancelled</small></div>
      <div className="card cloud-metric"><span>Waiting to sync</span><b>{pendingCount}</b><small>Queued on this device</small></div>
    </div>

    <section className="card content-card cloud-recent-orders">
      <div className="card-heading"><div><h2>Recent outlet orders</h2><p>No sales or trend estimates are shown here.</p></div><button className="text-link" onClick={() => onNavigate("Orders")}>View orders <ArrowRight size={14} /></button></div>
      {loading && orders.length === 0 ? <div className="empty-state"><Clock3 size={22} /><b>Loading outlet orders</b><span>Waiting for the cloud workspace to respond.</span></div> : orders.length === 0 ? <div className="empty-state"><ShoppingBag size={22} /><b>No outlet orders available</b><span>Orders will appear here when this outlet has records or queued syncs.</span></div> : <div className="cloud-order-list">
        {orders.slice(0, 6).map((order) => <div className="activity-row" key={order.id}>
          <span><b>{order.id}</b><small>{order.time}</small></span>
          <span>{order.items.reduce((sum, item) => sum + item.qty, 0)} items<small>{order.items[0]?.name ?? "No item details"}</small></span>
          <span>{order.type}{order.table && order.table !== "—" ? ` · ${order.table}` : ""}</span>
          <span className="role-tag">{order.status}</span>
        </div>)}
      </div>}
    </section>

    <div className="quick-actions cloud-quick-actions">
      <span className="quick-label">OUTLET SHORTCUTS</span>
      {canCreateOrders && <button onClick={() => onNavigate("POS")}><span className="quick-icon lime-icon"><ShoppingBag size={16} /></span><span><b>Start an order</b><small>Open the point of sale</small></span><ArrowRight size={15} /></button>}
      {canViewReports && <button onClick={() => onNavigate("Reports")}><span className="quick-icon lavender-icon"><Activity size={16} /></span><span><b>Reports</b><small>See current report availability</small></span><ArrowRight size={15} /></button>}
      {canManageTeam && <button onClick={() => onNavigate("Team")}><span className="quick-icon sage-icon"><Users size={16} /></span><span><b>Manage team access</b><small>Roles and outlet assignments</small></span><ArrowRight size={15} /> </button>}
    </div>
  </>;
}

function parseMilliQuantity(value: string): bigint | null {
  const cleaned = value.trim();
  if (!/^(?:\d{1,12})(?:\.\d{1,3})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  const milli = BigInt(whole) * 1000n + BigInt((fraction + "000").slice(0, 3));
  return milli > 0n && milli <= BigInt(Number.MAX_SAFE_INTEGER) ? milli : null;
}

function parseMilliNonNegative(value: string): bigint | null {
  const cleaned = value.trim();
  if (!/^(?:\d{1,12})(?:\.\d{1,3})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  const milli = BigInt(whole) * 1000n + BigInt((fraction + "000").slice(0, 3));
  return milli <= BigInt(Number.MAX_SAFE_INTEGER) ? milli : null;
}

function parseRupeesToPaise(value: string): bigint | null {
  const cleaned = value.trim();
  if (!/^(?:\d{1,12})(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const [rupees, paise = ""] = cleaned.split(".");
  return BigInt(rupees) * 100n + BigInt((paise + "00").slice(0, 2));
}

function formatMilliQuantity(value: string, unit: string) {
  const milli = BigInt(value);
  const whole = milli / 1000n;
  const fraction = (milli % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${new Intl.NumberFormat("en-IN").format(whole)}${fraction ? `.${fraction}` : ""} ${unit}`;
}

function formatStockValue(material: CloudMaterial) {
  const paise = (BigInt(material.quantityMilli) * BigInt(material.costPerUnitPaise) + 500n) / 1000n;
  const rupees = paise / 100n;
  const fraction = (paise % 100n).toString().padStart(2, "0");
  return `${new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(rupees)}.${fraction}`;
}

export function CloudInventoryPage({ outletId, canAdjustStock }: { outletId: string; canAdjustStock: boolean }) {
  const [materials, setMaterials] = useState<CloudMaterial[]>([]);
  const [vendors, setVendors] = useState<CloudVendor[]>([]);
  const [vendorCursor, setVendorCursor] = useState<string | null>(null);
  const [vendorLoading, setVendorLoading] = useState(false);
  const [vendorError, setVendorError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementKind, setMovementKind] = useState<"adjust" | "wastage">("adjust");
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [selectedMaterialId, setSelectedMaterialId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [movementError, setMovementError] = useState("");
  const [movementNotice, setMovementNotice] = useState("");
  const [savingMovement, setSavingMovement] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [newMaterialName, setNewMaterialName] = useState("");
  const [newMaterialUnit, setNewMaterialUnit] = useState("kg");
  const [newReorderQuantity, setNewReorderQuantity] = useState("0");
  const [newMaterialCost, setNewMaterialCost] = useState("0");
  const [materialError, setMaterialError] = useState("");
  const [savingMaterial, setSavingMaterial] = useState(false);
  const [vendorFormOpen, setVendorFormOpen] = useState(false);
  const [vendorName, setVendorName] = useState("");
  const [vendorPhone, setVendorPhone] = useState("");
  const [vendorEmail, setVendorEmail] = useState("");
  const [vendorGstin, setVendorGstin] = useState("");
  const [savingVendor, setSavingVendor] = useState(false);

  useEffect(() => {
    setMovementOpen(false);
    setSelectedMaterialId("");
    setMovementError("");
    setMovementNotice("");
    setMaterialOpen(false);
    setMaterialError("");
    setVendorFormOpen(false);
    setVendorError("");
  }, [outletId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setVendorLoading(true);
    setError("");
    setVendorError("");
    setVendors([]);
    setVendorCursor(null);
    if (!outletId) {
      setMaterials([]);
      setLoading(false);
      setVendorLoading(false);
      return;
    }
    void readJson<CloudMaterial[]>(`/api/inventory?outletId=${encodeURIComponent(outletId)}`)
      .then((result) => { if (!cancelled) setMaterials(result); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load outlet inventory."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    void readJson<{ items: CloudVendor[]; nextCursor: string | null }>(`/api/inventory/vendors?outletId=${encodeURIComponent(outletId)}`)
      .then((result) => { if (!cancelled) { setVendors(result.items); setVendorCursor(result.nextCursor); } })
      .catch((reason: unknown) => { if (!cancelled) setVendorError(reason instanceof Error ? reason.message : "Could not load outlet vendors."); })
      .finally(() => { if (!cancelled) setVendorLoading(false); });
    return () => { cancelled = true; };
  }, [outletId, refreshKey]);

  const lowStockCount = materials.filter((material) => BigInt(material.quantityMilli) <= BigInt(material.reorderMilli)).length;
  const submitMovement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMovementError("");
    setMovementNotice("");
    const quantityMilli = parseMilliQuantity(quantity);
    if (!selectedMaterialId || quantityMilli === null) {
      setMovementError("Enter a quantity greater than zero with up to three decimal places.");
      return;
    }
    const cleanedReason = reason.trim();
    if (cleanedReason.length < 3 || cleanedReason.length > 300) {
      setMovementError("Enter a reason between 3 and 300 characters.");
      return;
    }
    const signedQuantity = movementKind === "wastage" ? quantityMilli : direction === "remove" ? -quantityMilli : quantityMilli;
    setSavingMovement(true);
    try {
      await readJson("/api/inventory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outletId, rawMaterialId: selectedMaterialId, operation: movementKind, quantityMilli: signedQuantity.toString(), reason: cleanedReason }),
      });
      setMovementOpen(false);
      setQuantity("");
      setReason("");
      setRefreshKey((key) => key + 1);
      setMovementNotice(movementKind === "wastage" ? "Wastage recorded and stock updated." : "Stock correction saved and audited.");
    } catch (reason) {
      setMovementError(reason instanceof Error ? reason.message : "Could not save the stock movement.");
    } finally {
      setSavingMovement(false);
    }
  };

  const submitMaterial = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMaterialError("");
    const name = newMaterialName.trim();
    const unit = newMaterialUnit.trim();
    const reorderMilli = parseMilliNonNegative(newReorderQuantity);
    const costPerUnitPaise = parseRupeesToPaise(newMaterialCost);
    if (!name || name.length > 100 || !unit || unit.length > 16 || reorderMilli === null || costPerUnitPaise === null) {
      setMaterialError("Enter a name, unit, valid reorder quantity (up to three decimals), and unit cost (up to two decimals).");
      return;
    }
    setSavingMaterial(true);
    try {
      const result = await readJson<{ material: CloudMaterial }>("/api/inventory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outletId, operation: "create", name, unit, reorderMilli: reorderMilli.toString(), costPerUnitPaise: costPerUnitPaise.toString() }),
      });
      setMaterialOpen(false);
      setNewMaterialName("");
      setNewMaterialUnit("kg");
      setNewReorderQuantity("0");
      setNewMaterialCost("0");
      setSelectedMaterialId(result.material.id);
      setMovementKind("adjust");
      setDirection("add");
      setRefreshKey((key) => key + 1);
      setMovementOpen(true);
      setMovementNotice("Ingredient created. You can record its opening stock below.");
    } catch (reason) {
      setMaterialError(reason instanceof Error ? reason.message : "Could not create this ingredient.");
    } finally {
      setSavingMaterial(false);
    }
  };

  const submitVendor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setVendorError("");
    const name = vendorName.trim();
    if (name.length < 2 || name.length > 100) {
      setVendorError("Vendor name must contain 2–100 characters.");
      return;
    }
    setSavingVendor(true);
    try {
      await readJson<{ vendor: CloudVendor }>("/api/inventory/vendors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outletId, name, phone: vendorPhone, email: vendorEmail, gstin: vendorGstin }),
      });
      setVendorFormOpen(false);
      setVendorName(""); setVendorPhone(""); setVendorEmail(""); setVendorGstin("");
      setRefreshKey((key) => key + 1);
    } catch (reason) {
      setVendorError(reason instanceof Error ? reason.message : "Could not save vendor details.");
    } finally {
      setSavingVendor(false);
    }
  };

  const toggleVendor = async (vendor: CloudVendor) => {
    setVendorError("");
    try {
      const result = await readJson<{ vendor: CloudVendor }>("/api/inventory/vendors", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outletId, vendorId: vendor.id, active: !vendor.active }),
      });
      setVendors((current) => current.map((item) => item.id === result.vendor.id ? result.vendor : item));
    } catch (reason) {
      setVendorError(reason instanceof Error ? reason.message : "Could not update vendor status.");
    }
  };

  const loadMoreVendors = async () => {
    if (!vendorCursor || vendorLoading) return;
    setVendorLoading(true);
    setVendorError("");
    try {
      const result = await readJson<{ items: CloudVendor[]; nextCursor: string | null }>(`/api/inventory/vendors?outletId=${encodeURIComponent(outletId)}&cursor=${encodeURIComponent(vendorCursor)}`);
      setVendors((current) => [...current, ...result.items]);
      setVendorCursor(result.nextCursor);
    } catch (reason) {
      setVendorError(reason instanceof Error ? reason.message : "Could not load more vendors.");
    } finally {
      setVendorLoading(false);
    }
  };

  return <>
    <div className="page-title-row"><div><p className="eyebrow">BACK OF HOUSE · LIVE DATA</p><h1>Inventory</h1><p className="muted">Current raw-material balances for this outlet.</p></div><div className="title-actions">{canAdjustStock && <button className="primary-button" onClick={() => { setMaterialOpen(true); setMaterialError(""); }}><Plus size={15} /> Add ingredient</button>}{canAdjustStock && materials.length > 0 && <button className="secondary-button" onClick={() => { setSelectedMaterialId(materials[0].id); setMovementOpen(true); setMovementError(""); }}><Package size={15} /> Record stock movement</button>}<button className="secondary-button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}><RefreshCw size={15} /> Refresh stock</button></div></div>
    {error && <div className="cloud-data-notice" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
    {movementNotice && <div className="cloud-data-notice" role="status" aria-live="polite"><Package size={16} /><span>{movementNotice}</span></div>}
    {materialOpen && canAdjustStock && <form className="card inventory-movement-form" onSubmit={submitMaterial} aria-labelledby="inventory-create-title">
      <div className="inventory-movement-heading"><div><p className="eyebrow">OUTLET INGREDIENT</p><h2 id="inventory-create-title">Add ingredient</h2><p className="muted">The opening balance starts at zero. Record a stock movement after saving.</p></div><button type="button" className="secondary-button" onClick={() => setMaterialOpen(false)} disabled={savingMaterial}>Cancel</button></div>
      <div className="inventory-movement-fields">
        <label>Ingredient name<input required maxLength={100} value={newMaterialName} onChange={(event) => setNewMaterialName(event.target.value)} placeholder="e.g. Basmati rice" /></label>
        <label>Stock unit<input required maxLength={16} value={newMaterialUnit} onChange={(event) => setNewMaterialUnit(event.target.value)} placeholder="kg, L, pcs" /></label>
        <label>Reorder level<input required inputMode="decimal" value={newReorderQuantity} onChange={(event) => setNewReorderQuantity(event.target.value)} placeholder="0.000" /></label>
        <label>Cost per unit (₹)<input required inputMode="decimal" value={newMaterialCost} onChange={(event) => setNewMaterialCost(event.target.value)} placeholder="0.00" /></label>
      </div>
      <div className="inventory-movement-footer"><small>Enter the cost for one selected stock unit. Quantity precision is 0.001.</small><button className="primary-button" type="submit" disabled={savingMaterial}>{savingMaterial ? "Saving…" : "Create ingredient"}</button></div>
      {materialError && <p className="inventory-movement-error" role="alert">{materialError}</p>}
    </form>}
    {movementOpen && canAdjustStock && materials.some((material) => material.id === selectedMaterialId) && <form className="card inventory-movement-form" onSubmit={submitMovement} aria-labelledby="inventory-movement-title">
      <div className="inventory-movement-heading"><div><p className="eyebrow">AUDITED STOCK MOVEMENT</p><h2 id="inventory-movement-title">Record stock change</h2><p className="muted">Quantities support up to three decimal places. Every change needs a reason.</p></div><button type="button" className="secondary-button" onClick={() => setMovementOpen(false)} disabled={savingMovement}>Cancel</button></div>
      <div className="inventory-movement-fields">
        <label>Ingredient<select required value={selectedMaterialId} onChange={(event) => setSelectedMaterialId(event.target.value)}>{materials.map((material) => <option key={material.id} value={material.id}>{material.name} · {material.unit}</option>)}</select></label>
        <label>Movement<select value={movementKind} onChange={(event) => setMovementKind(event.target.value as "adjust" | "wastage")}><option value="adjust">Stock correction</option><option value="wastage">Wastage</option></select></label>
        {movementKind === "adjust" && <label>Direction<select value={direction} onChange={(event) => setDirection(event.target.value as "add" | "remove")}><option value="add">Add stock</option><option value="remove">Remove stock</option></select></label>}
        <label>Quantity<input required inputMode="decimal" autoComplete="off" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="e.g. 1.250" aria-describedby="inventory-quantity-help" /></label>
        <label className="inventory-reason-field">Reason<input required minLength={3} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={movementKind === "wastage" ? "e.g. spoiled during storage" : "e.g. physical stock count"} /></label>
      </div>
      <div className="inventory-movement-footer"><small id="inventory-quantity-help">Stored in milli-units; 1.000 {materials.find((item) => item.id === selectedMaterialId)?.unit ?? "unit"} = 1,000 milli-units.</small><button className="primary-button" type="submit" disabled={savingMovement}>{savingMovement ? "Saving…" : "Save movement"}</button></div>
      {movementError && <p className="inventory-movement-error" role="alert">{movementError}</p>}
    </form>}
    <div className="stats-grid inventory-stats">
      <div className="card cloud-metric"><span>Tracked ingredients</span><b>{loading ? "…" : materials.length}</b><small>Raw materials set up for this outlet</small></div>
      <div className="card cloud-metric"><span>At or below reorder level</span><b>{loading ? "…" : lowStockCount}</b><small>Based on saved reorder quantities</small></div>
      <div className="card cloud-metric"><span>Inventory workflows</span><b>Active</b><small>Stock corrections, wastage, and vendors</small></div>
    </div>
    <div className="card content-card">
      <div className="table-toolbar"><div><h2 className="section-title">Stock levels</h2></div><span className="muted">Values use stored unit cost and on-hand quantity.</span></div>
      {loading && materials.length === 0 ? <div className="empty-state"><Package size={23} /><b>Loading stock</b><span>Reading the selected outlet’s inventory.</span></div> : materials.length === 0 ? <div className="empty-state"><Box size={23} /><b>No ingredients set up</b><span>{canAdjustStock ? "Add the outlet’s first ingredient to begin tracking stock." : "This cloud outlet has no raw-material records yet. Demo stock is not shown here."}</span></div> : <div className="wide-table">
        <div className="table-head inventory-head cloud-inventory-head"><span>INGREDIENT</span><span>ON HAND</span><span>REORDER LEVEL</span><span>STATUS</span><span>EST. VALUE</span></div>
        {materials.map((material) => {
          const quantity = BigInt(material.quantityMilli);
          const reorder = BigInt(material.reorderMilli);
          const status = quantity === 0n ? "Out of stock" : quantity <= reorder ? "Reorder" : "In stock";
          return <div className="inventory-row cloud-inventory-row" key={material.id}>
            <span className="cloud-material-name"><b>{material.name}</b>{canAdjustStock && <button type="button" className="cloud-stock-action" onClick={() => { setSelectedMaterialId(material.id); setMovementOpen(true); setMovementError(""); }} aria-label={`Record stock movement for ${material.name}`}>Adjust</button>}</span><span>{formatMilliQuantity(material.quantityMilli, material.unit)}</span><span>{formatMilliQuantity(material.reorderMilli, material.unit)}</span><span><span className="role-tag">{status}</span></span><b>{formatStockValue(material)}</b>
          </div>;
        })}
      </div>}
    </div>
    <section className="card content-card cloud-vendors" aria-labelledby="cloud-vendors-title">
      <div className="cloud-vendors-heading"><div><h2 id="cloud-vendors-title">Vendors</h2><p className="muted">Vendor directory shared by outlets in this tenant.</p></div>{canAdjustStock && <button className="secondary-button" onClick={() => { setVendorFormOpen(true); setVendorError(""); }}><Plus size={15} /> Add vendor</button>}</div>
      {vendorError && <div className="cloud-data-notice" role="alert"><AlertTriangle size={15} /><span>{vendorError}</span></div>}
      {vendorFormOpen && canAdjustStock && <form className="vendor-form" onSubmit={submitVendor} aria-label="Add vendor">
        <label>Vendor name<input required minLength={2} maxLength={100} value={vendorName} onChange={(event) => setVendorName(event.target.value)} placeholder="e.g. Green Valley Produce" /></label>
        <label>Phone<input type="tel" maxLength={20} value={vendorPhone} onChange={(event) => setVendorPhone(event.target.value)} placeholder="+91 98765 43210" /></label>
        <label>Email<input type="email" maxLength={254} value={vendorEmail} onChange={(event) => setVendorEmail(event.target.value)} placeholder="orders@example.in" /></label>
        <label>GSTIN<input maxLength={15} value={vendorGstin} onChange={(event) => setVendorGstin(event.target.value.toUpperCase())} placeholder="Optional" /></label>
        <div className="vendor-form-actions"><button type="button" className="secondary-button" onClick={() => setVendorFormOpen(false)} disabled={savingVendor}>Cancel</button><button type="submit" className="primary-button" disabled={savingVendor}>{savingVendor ? "Saving…" : "Save vendor"}</button></div>
      </form>}
      {vendorLoading && vendors.length === 0 ? <div className="empty-state"><Truck size={22} /><b>Loading vendors</b><span>Reading the tenant vendor directory.</span></div> : vendors.length === 0 ? <div className="empty-state"><Truck size={22} /><b>No vendors recorded</b><span>{canAdjustStock ? "Add suppliers here; purchase receipts will be linked when that workflow is enabled." : "No tenant vendors are available."}</span></div> : <div className="cloud-vendor-list">
        {vendors.map((vendor) => <article className={`cloud-vendor-row ${vendor.active ? "" : "inactive"}`} key={vendor.id}>
          <span className="vendor-icon"><Truck size={16} /></span><span className="vendor-details"><b>{vendor.name}</b><small>{[vendor.phone, vendor.email, vendor.gstin].filter(Boolean).join(" · ") || "No contact details"}</small></span><span className={`role-tag ${vendor.active ? "" : "inactive-tag"}`}>{vendor.active ? "Active" : "Inactive"}</span>{canAdjustStock && <button type="button" className="cloud-stock-action" onClick={() => void toggleVendor(vendor)} aria-label={`${vendor.active ? "Deactivate" : "Activate"} ${vendor.name}`}>{vendor.active ? "Deactivate" : "Activate"}</button>}
        </article>)}
      </div>}
      {vendorCursor && <div className="vendor-load-more"><button type="button" className="secondary-button" onClick={() => void loadMoreVendors()} disabled={vendorLoading}>{vendorLoading ? "Loading…" : "Load more vendors"}</button></div>}
    </section>
    <div className="cloud-data-notice"><Package size={16} /><span>Ingredient stock corrections, wastage, and the shared vendor directory are active. Purchase receipts, recipe-linked deductions, and stock-to-sale reconciliation remain open.</span></div>
  </>;
}

export function CloudCustomersPage({ customers, onAdd }: { customers: CloudCustomer[]; onAdd: () => void }) {
  const [query, setQuery] = useState("");
  const filteredCustomers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? customers.filter((customer) => `${customer.name} ${customer.phone}`.toLocaleLowerCase().includes(needle)) : customers;
  }, [customers, query]);
  const visitCount = customers.reduce((sum, customer) => sum + customer.visits, 0);
  const recordedOrderValue = customers.reduce((sum, customer) => sum + customer.spend, 0);
  const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

  return <>
    <div className="page-title-row"><div><p className="eyebrow">GUEST RELATIONSHIPS · LIVE DATA</p><h1>Customers</h1><p className="muted">Customer records linked to this outlet.</p></div><button className="primary-button" onClick={onAdd}><Users size={16} /> Add customer</button></div>
    <div className="stats-grid customer-stats">
      <div className="card cloud-metric"><span>Customer records</span><b>{customers.length}</b><small>Returned for this outlet</small></div>
      <div className="card cloud-metric"><span>Recorded visits</span><b>{visitCount.toLocaleString("en-IN")}</b><small>Stored visit count</small></div>
      <div className="card cloud-metric"><span>Recorded order value</span><b>{currency.format(recordedOrderValue)}</b><small>Order value stored against these customers</small></div>
    </div>
    <div className="card content-card">
      <div className="table-toolbar"><div><h2 className="section-title">Guest book <span className="count-bubble">{filteredCustomers.length}</span></h2></div><div className="search-box compact"><Search size={15} /><input aria-label="Search customers" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a guest" /></div></div>
      {filteredCustomers.length === 0 ? <div className="empty-state"><Users size={23} /><b>{customers.length ? "No customers match" : "No customer records yet"}</b><span>{customers.length ? "Try a different name or phone suffix." : "Customers linked to orders will appear here. No sample accounts are mixed into cloud data."}</span></div> : <div className="wide-table">
        <div className="table-head customer-head cloud-customer-head"><span>GUEST</span><span>PHONE</span><span>VISITS</span><span>RECORDED ORDER VALUE</span></div>
        {filteredCustomers.map((customer, index) => <div className="customer-row cloud-customer-row" key={customer.id ?? customer.phone}>
          <span className="customer-name-cell"><i className={`avatar avatar-${index % 4}`}>{customer.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</i><b>{customer.name}</b></span>
          <span>{customer.phone}</span><span>{customer.visits.toLocaleString("en-IN")}</span><b>{currency.format(customer.spend)}</b>
        </div>)}
      </div>}
      <div className="table-bottom"><span>Cloud records are outlet-scoped; phone numbers are masked by the API.</span><span className="muted">Loyalty points are not enabled.</span></div>
    </div>
  </>;
}

export function CloudReportsPage() {
  return <>
    <div className="page-title-row"><div><p className="eyebrow">INSIGHTS · CLOUD ACCOUNT</p><h1>Reports</h1><p className="muted">Sales and tax reporting must reconcile against stored bills and payments.</p></div></div>
    <div className="card cloud-report-state">
      <span className="feature-icon"><Activity size={22} /></span>
      <h2>Live report aggregation is not available yet</h2>
      <p>Cloud reports and export endpoints are not part of this release. No sample sales, GST, payment mix, or trend numbers are shown as outlet results.</p>
      <small>Reporting is planned for Phase 4 and must reconcile bills, refunds, discounts, GST, and settlements before it is enabled.</small>
    </div>
  </>;
}
