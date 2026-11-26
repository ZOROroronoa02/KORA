"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowRight, Box, Clock3, Package, RefreshCw, Search, ShoppingBag, Users } from "lucide-react";
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

export function CloudInventoryPage({ outletId }: { outletId: string }) {
  const [materials, setMaterials] = useState<CloudMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    if (!outletId) {
      setMaterials([]);
      setLoading(false);
      return;
    }
    void readJson<CloudMaterial[]>(`/api/inventory?outletId=${encodeURIComponent(outletId)}`)
      .then((result) => { if (!cancelled) setMaterials(result); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load outlet inventory."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [outletId, refreshKey]);

  const lowStockCount = materials.filter((material) => BigInt(material.quantityMilli) <= BigInt(material.reorderMilli)).length;
  const quantityLabel = (value: string, unit: string) => `${(Number(value) / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${unit}`;
  const valueLabel = (material: CloudMaterial) => {
    const paise = Number(material.quantityMilli) * Number(material.costPerUnitPaise) / 1000;
    return Number.isFinite(paise) ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100) : "—";
  };

  return <>
    <div className="page-title-row"><div><p className="eyebrow">BACK OF HOUSE · LIVE DATA</p><h1>Inventory</h1><p className="muted">Current raw-material balances for this outlet.</p></div><button className="secondary-button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}><RefreshCw size={15} /> Refresh stock</button></div>
    {error && <div className="cloud-data-notice" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
    <div className="stats-grid inventory-stats">
      <div className="card cloud-metric"><span>Tracked ingredients</span><b>{loading ? "…" : materials.length}</b><small>Raw materials set up for this outlet</small></div>
      <div className="card cloud-metric"><span>At or below reorder level</span><b>{loading ? "…" : lowStockCount}</b><small>Based on saved reorder quantities</small></div>
      <div className="card cloud-metric"><span>Inventory workflows</span><b>Phase 2</b><small>Purchases, recipes, and wastage are not enabled yet</small></div>
    </div>
    <div className="card content-card">
      <div className="table-toolbar"><div><h2 className="section-title">Stock levels</h2></div><span className="muted">Values use stored unit cost and on-hand quantity.</span></div>
      {loading && materials.length === 0 ? <div className="empty-state"><Package size={23} /><b>Loading stock</b><span>Reading the selected outlet’s inventory.</span></div> : materials.length === 0 ? <div className="empty-state"><Box size={23} /><b>No ingredients set up</b><span>This cloud outlet has no raw-material records yet. Demo stock is not shown here.</span></div> : <div className="wide-table">
        <div className="table-head inventory-head cloud-inventory-head"><span>INGREDIENT</span><span>ON HAND</span><span>REORDER LEVEL</span><span>STATUS</span><span>EST. VALUE</span></div>
        {materials.map((material) => {
          const quantity = BigInt(material.quantityMilli);
          const reorder = BigInt(material.reorderMilli);
          const status = quantity === 0n ? "Out of stock" : quantity <= reorder ? "Reorder" : "In stock";
          return <div className="inventory-row cloud-inventory-row" key={material.id}>
            <span><b>{material.name}</b></span><span>{quantityLabel(material.quantityMilli, material.unit)}</span><span>{quantityLabel(material.reorderMilli, material.unit)}</span><span><span className="role-tag">{status}</span></span><b>{valueLabel(material)}</b>
          </div>;
        })}
      </div>}
    </div>
    <div className="cloud-data-notice"><Package size={16} /><span>Recipe-linked deductions, purchase orders, and wastage tracking are planned for Phase 2.</span></div>
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
