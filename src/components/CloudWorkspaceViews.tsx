"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Activity, AlertTriangle, ArrowRight, Box, CalendarDays, Clock3, Download, Package, Plus, RefreshCw, Search, ShoppingBag, Truck, Users } from "lucide-react";
import { apiFetch, readJson } from "@/lib/client-api";

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
type CloudRecipeIngredient = { rawMaterialId: string; quantityMilli: string; rawMaterial: { id: string; name: string; unit: string; quantityMilli: string } };
type CloudRecipe = { id: string; menuItemId: string; yieldQuantity: number; menuItem: { id: string; name: string }; ingredients: CloudRecipeIngredient[] };
type CloudRecipeMenuItem = { id: string; name: string };
type SalesReport = {
  range: { from: string; to: string; timeZone: string; maxDays: number };
  summary: { billCount: number };
  financials?: { subtotalPaise: string; discountPaise: string; taxablePaise: string; cgstPaise: string; sgstPaise: string; igstPaise: string; serviceChargePaise: string; billedTotalPaise: string };
  daily: Array<{ date: string; billCount: number; totalPaise?: string }>;
  topItems: Array<{ name: string; quantity: string; salesPaise?: string }>;
  paymentActivity?: Array<{ method: string; amountPaise: string }>;
  refundActivity?: Array<{ method: string; amountPaise: string }>;
  gstSummary?: Array<{ documentType: string; gstProfile: string; taxablePaise: string; cgstPaise: string; sgstPaise: string; igstPaise: string }>;
};
type ShiftReportRow = {
  id: string;
  cashierName: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingCashPaise: string;
  cashCapturedPaise: string;
  cashRefundedPaise: string;
  expectedCashPaise: string;
  countedCashPaise: string | null;
  variancePaise: string | null;
  ledgerExpectedCashPaise: string;
  ledgerMatchesClose: boolean;
  payments: Array<{ method: string; amountPaise: string }>;
  refunds: Array<{ method: string; amountPaise: string }>;
};
type ShiftReport = { rows: ShiftReportRow[]; nextCursor: string | null; pageSize: number; range: { from: string; to: string; timeZone: string } };

function currentIndiaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatReportPaise(value: string | undefined) {
  const amount = BigInt(value ?? "0");
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const rupees = new Intl.NumberFormat("en-IN").format(absolute / 100n);
  return `${sign}₹${rupees}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

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
      {canViewReports && <button onClick={() => onNavigate("Reports")}><span className="quick-icon lavender-icon"><Activity size={16} /></span><span><b>Reports</b><small>Review saved sales and payments</small></span><ArrowRight size={15} /></button>}
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

function formatMilliInput(value: string) {
  const milli = BigInt(value);
  const whole = milli / 1000n;
  const fraction = (milli % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function formatMilliQuantity(value: string, unit: string) {
  const signedMilli = BigInt(value);
  const magnitude = signedMilli < 0n ? -signedMilli : signedMilli;
  const whole = magnitude / 1000n;
  const fraction = (magnitude % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${signedMilli < 0n ? "−" : ""}${new Intl.NumberFormat("en-IN").format(whole)}${fraction ? `.${fraction}` : ""} ${unit}`;
}

function formatStockValue(material: CloudMaterial) {
  const rawPaise = BigInt(material.quantityMilli) * BigInt(material.costPerUnitPaise);
  const roundedPaise = (rawPaise < 0n ? -((-rawPaise + 500n) / 1000n) : (rawPaise + 500n) / 1000n);
  const magnitude = roundedPaise < 0n ? -roundedPaise : roundedPaise;
  const rupees = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, "0");
  const formattedRupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(rupees);
  return `${roundedPaise < 0n ? "−" : ""}${formattedRupees}.${fraction}`;
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
  const [recipes, setRecipes] = useState<CloudRecipe[]>([]);
  const [recipeMenuItems, setRecipeMenuItems] = useState<CloudRecipeMenuItem[]>([]);
  const [recipeCursor, setRecipeCursor] = useState<string | null>(null);
  const [recipeMenuCursor, setRecipeMenuCursor] = useState<string | null>(null);
  const [recipeLoading, setRecipeLoading] = useState(true);
  const [recipeLoadingMore, setRecipeLoadingMore] = useState(false);
  const [recipeError, setRecipeError] = useState("");
  const [recipeNotice, setRecipeNotice] = useState("");
  const [recipeEditorOpen, setRecipeEditorOpen] = useState(false);
  const [recipeOperation, setRecipeOperation] = useState<"create" | "update">("create");
  const [editingRecipeMenuItemId, setEditingRecipeMenuItemId] = useState("");
  const [recipeYield, setRecipeYield] = useState("1");
  const [recipeIngredients, setRecipeIngredients] = useState<Array<{ rawMaterialId: string; quantity: string }>>([]);
  const [savingRecipe, setSavingRecipe] = useState(false);

  useEffect(() => {
    setMovementOpen(false);
    setSelectedMaterialId("");
    setMovementError("");
    setMovementNotice("");
    setMaterialOpen(false);
    setMaterialError("");
    setVendorFormOpen(false);
    setVendorError("");
    setRecipeEditorOpen(false);
    setRecipeError("");
    setRecipeNotice("");
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

  useEffect(() => {
    let cancelled = false;
    setRecipeLoading(true);
    setRecipeError("");
    setRecipes([]);
    setRecipeMenuItems([]);
    setRecipeCursor(null);
    setRecipeMenuCursor(null);
    if (!outletId) {
      setRecipeLoading(false);
      return;
    }
    void readJson<{ recipes: CloudRecipe[]; nextCursor: string | null; menuItems: CloudRecipeMenuItem[]; nextMenuCursor: string | null }>(`/api/inventory/recipes?outletId=${encodeURIComponent(outletId)}&take=100&menuTake=100`)
      .then((result) => {
        if (!cancelled) {
          setRecipes(result.recipes);
          setRecipeCursor(result.nextCursor);
          setRecipeMenuItems(result.menuItems);
          setRecipeMenuCursor(result.nextMenuCursor);
        }
      })
      .catch((reason: unknown) => { if (!cancelled) setRecipeError(reason instanceof Error ? reason.message : "Could not load outlet recipes."); })
      .finally(() => { if (!cancelled) setRecipeLoading(false); });
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

  const openRecipeEditor = (recipe?: CloudRecipe) => {
    setRecipeError("");
    setRecipeNotice("");
    if (recipe) {
      setRecipeOperation("update");
      setRecipeMenuItems((current) => current.some((item) => item.id === recipe.menuItemId) ? current : [...current, recipe.menuItem]);
      setEditingRecipeMenuItemId(recipe.menuItemId);
      setRecipeYield(String(recipe.yieldQuantity));
      setRecipeIngredients(recipe.ingredients.map((ingredient) => ({ rawMaterialId: ingredient.rawMaterialId, quantity: formatMilliInput(ingredient.quantityMilli) })));
    } else {
      setRecipeOperation("create");
      const configured = new Set(recipes.map((item) => item.menuItemId));
      const firstAvailable = recipeMenuItems.find((item) => !configured.has(item.id));
      setEditingRecipeMenuItemId(firstAvailable?.id ?? "");
      setRecipeYield("1");
      setRecipeIngredients([{ rawMaterialId: materials[0]?.id ?? "", quantity: "" }]);
    }
    setRecipeEditorOpen(true);
  };

  const submitRecipe = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRecipeError("");
    setRecipeNotice("");
    const yieldQuantity = Number(recipeYield);
    const mappedIngredients = recipeIngredients.map((ingredient) => ({ rawMaterialId: ingredient.rawMaterialId, quantityMilli: parseMilliQuantity(ingredient.quantity) }));
    if (!editingRecipeMenuItemId || !Number.isSafeInteger(yieldQuantity) || yieldQuantity < 1 || yieldQuantity > 10000) {
      setRecipeError("Select a menu item and enter a batch yield from 1 to 10,000 portions.");
      return;
    }
    if (mappedIngredients.length < 1 || mappedIngredients.length > 50 || mappedIngredients.some((item) => !item.rawMaterialId || item.quantityMilli === null) || new Set(mappedIngredients.map((item) => item.rawMaterialId)).size !== mappedIngredients.length) {
      setRecipeError("Choose unique outlet ingredients and enter positive quantities with up to three decimal places.");
      return;
    }
    setSavingRecipe(true);
    try {
      await readJson<{ recipe: CloudRecipe }>("/api/inventory/recipes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: recipeOperation, outletId, menuItemId: editingRecipeMenuItemId, yieldQuantity, ingredients: mappedIngredients.map((item) => ({ rawMaterialId: item.rawMaterialId, quantityMilli: item.quantityMilli!.toString() })) }),
      });
      setRecipeEditorOpen(false);
      setRecipeNotice("Recipe saved for this outlet. Stock deduction on sales is not enabled yet.");
      setRefreshKey((key) => key + 1);
    } catch (reason) {
      setRecipeError(reason instanceof Error ? reason.message : "Could not save this recipe.");
    } finally {
      setSavingRecipe(false);
    }
  };

  const deleteRecipe = async (recipe: CloudRecipe) => {
    if (!window.confirm(`Remove the recipe for ${recipe.menuItem.name}? Historical orders will not be changed.`)) return;
    setRecipeError("");
    setRecipeNotice("");
    try {
      await readJson(`/api/inventory/recipes?outletId=${encodeURIComponent(outletId)}&menuItemId=${encodeURIComponent(recipe.menuItemId)}`, { method: "DELETE" });
      setRecipeNotice(`Recipe for ${recipe.menuItem.name} removed.`);
      setRefreshKey((key) => key + 1);
    } catch (reason) {
      setRecipeError(reason instanceof Error ? reason.message : "Could not remove this recipe.");
    }
  };

  const loadMoreRecipes = async () => {
    if (!recipeCursor || recipeLoadingMore) return;
    setRecipeLoadingMore(true);
    setRecipeError("");
    try {
      const result = await readJson<{ recipes: CloudRecipe[]; nextCursor: string | null }>(`/api/inventory/recipes?outletId=${encodeURIComponent(outletId)}&take=100&cursor=${encodeURIComponent(recipeCursor)}&menuTake=1`);
      setRecipes((current) => [...current, ...result.recipes]);
      setRecipeCursor(result.nextCursor);
    } catch (reason) {
      setRecipeError(reason instanceof Error ? reason.message : "Could not load more recipes.");
    } finally {
      setRecipeLoadingMore(false);
    }
  };

  const loadMoreRecipeMenuItems = async () => {
    if (!recipeMenuCursor || recipeLoadingMore) return;
    setRecipeLoadingMore(true);
    setRecipeError("");
    try {
      const result = await readJson<{ menuItems: CloudRecipeMenuItem[]; nextMenuCursor: string | null }>(`/api/inventory/recipes?outletId=${encodeURIComponent(outletId)}&take=1&menuTake=100&menuCursor=${encodeURIComponent(recipeMenuCursor)}`);
      setRecipeMenuItems((current) => [...current, ...result.menuItems]);
      setRecipeMenuCursor(result.nextMenuCursor);
    } catch (reason) {
      setRecipeError(reason instanceof Error ? reason.message : "Could not load more menu items.");
    } finally {
      setRecipeLoadingMore(false);
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
          const status = quantity < 0n ? "Shortage" : quantity === 0n ? "Out of stock" : quantity <= reorder ? "Reorder" : "In stock";
          return <div className="inventory-row cloud-inventory-row" key={material.id}>
            <span className="cloud-material-name"><b>{material.name}</b>{canAdjustStock && <button type="button" className="cloud-stock-action" onClick={() => { setSelectedMaterialId(material.id); setMovementOpen(true); setMovementError(""); }} aria-label={`Record stock movement for ${material.name}`}>Adjust</button>}</span><span>{formatMilliQuantity(material.quantityMilli, material.unit)}</span><span>{formatMilliQuantity(material.reorderMilli, material.unit)}</span><span><span className="role-tag">{status}</span></span><b>{formatStockValue(material)}</b>
          </div>;
        })}
      </div>}
    </div>
    <section className="card content-card cloud-recipes" aria-labelledby="cloud-recipes-title">
      <div className="cloud-vendors-heading"><div><h2 id="cloud-recipes-title">Outlet recipes</h2><p className="muted">Define raw materials and batch yield for each menu item in this outlet.</p></div>{canAdjustStock && <button className="primary-button" onClick={() => openRecipeEditor()} disabled={!materials.length || (!recipeMenuItems.some((item) => !recipes.some((recipe) => recipe.menuItemId === item.id)) && !recipeMenuCursor)}><Plus size={15} /> Add recipe</button>}</div>
      {recipeError && <div className="cloud-data-notice" role="alert"><AlertTriangle size={15} /><span>{recipeError}</span></div>}
      {recipeNotice && <div className="cloud-data-notice" role="status" aria-live="polite"><Package size={15} /><span>{recipeNotice}</span></div>}
      {recipeEditorOpen && canAdjustStock && <form className="recipe-form" onSubmit={submitRecipe} aria-label="Recipe editor">
        <div className="recipe-fields">
          <label>Menu item<select required value={editingRecipeMenuItemId} disabled={recipeOperation === "update"} onChange={(event) => setEditingRecipeMenuItemId(event.target.value)}><option value="">Select a menu item</option>{recipeMenuItems.map((item) => { const configured = recipes.some((recipe) => recipe.menuItemId === item.id && recipe.menuItemId !== editingRecipeMenuItemId); return <option key={item.id} value={item.id} disabled={configured}>{item.name}{configured ? " · recipe exists" : ""}</option>; })}</select></label>
          <label>Batch yield (portions)<input required inputMode="numeric" min={1} max={10000} step={1} value={recipeYield} onChange={(event) => setRecipeYield(event.target.value)} /></label>
        </div>
        <div className="recipe-ingredients-heading"><div><b>Ingredients per batch</b><small>Use the same outlet stock unit shown beside each ingredient.</small></div><button type="button" className="secondary-button" onClick={() => setRecipeIngredients((current) => current.length < 50 ? [...current, { rawMaterialId: materials.find((material) => !current.some((entry) => entry.rawMaterialId === material.id))?.id ?? "", quantity: "" }] : current)} disabled={recipeIngredients.length >= 50 || recipeIngredients.length >= materials.length}>Add ingredient</button></div>
        {materials.length === 0 ? <p className="recipe-empty-note">Add at least one raw material before creating a recipe.</p> : recipeIngredients.map((ingredient, index) => <div className="recipe-ingredient-row" key={`recipe-ingredient-${index}`}>
          <label>Ingredient<select required value={ingredient.rawMaterialId} onChange={(event) => setRecipeIngredients((current) => current.map((entry, row) => row === index ? { ...entry, rawMaterialId: event.target.value } : entry))}><option value="">Select ingredient</option>{materials.map((material) => <option key={material.id} value={material.id} disabled={recipeIngredients.some((entry, row) => row !== index && entry.rawMaterialId === material.id)}>{material.name} · {material.unit}</option>)}</select></label>
          <label>Quantity<input required inputMode="decimal" value={ingredient.quantity} onChange={(event) => setRecipeIngredients((current) => current.map((entry, row) => row === index ? { ...entry, quantity: event.target.value } : entry))} placeholder="e.g. 0.180" /><small>Maximum 3 decimal places.</small></label>
          <button type="button" className="recipe-remove-button" onClick={() => setRecipeIngredients((current) => current.filter((_, row) => row !== index))} disabled={recipeIngredients.length <= 1}>Remove</button>
        </div>)}
        <div className="recipe-form-footer"><small>Amounts are stored as integer milli-units. A yield of 1 means the listed quantities make one sale portion.</small><div><button type="button" className="secondary-button" onClick={() => setRecipeEditorOpen(false)} disabled={savingRecipe}>Cancel</button><button type="submit" className="primary-button" disabled={savingRecipe || !materials.length}>{savingRecipe ? "Saving…" : "Save recipe"}</button></div></div>
      </form>}
      {recipeLoading && recipes.length === 0 ? <div className="empty-state"><Package size={22} /><b>Loading recipes</b><span>Reading recipes for the selected outlet.</span></div> : recipes.length === 0 ? <div className="empty-state"><Box size={22} /><b>No recipes saved</b><span>{canAdjustStock ? "Add ingredients and menu items first, then map each sale portion to its raw-material usage." : "This outlet has no recipe records yet."}</span></div> : <div className="recipe-list">{recipes.map((recipe) => <article className="recipe-card" key={recipe.id}>
        <div className="recipe-card-heading"><div><b>{recipe.menuItem.name}</b><small>Batch yield: {recipe.yieldQuantity} portion{recipe.yieldQuantity === 1 ? "" : "s"}</small></div>{canAdjustStock && <div><button type="button" className="secondary-button" onClick={() => openRecipeEditor(recipe)}>Edit</button><button type="button" className="recipe-remove-button" onClick={() => void deleteRecipe(recipe)}>Remove</button></div>}</div>
        <ul>{recipe.ingredients.map((ingredient) => <li key={ingredient.rawMaterialId}><span>{ingredient.rawMaterial.name}</span><b>{formatMilliQuantity(ingredient.quantityMilli, ingredient.rawMaterial.unit)}</b></li>)}</ul>
      </article>)}</div>}
      {recipeCursor && <div className="vendor-load-more"><button type="button" className="secondary-button" onClick={() => void loadMoreRecipes()} disabled={recipeLoadingMore}>{recipeLoadingMore ? "Loading…" : "Load more recipes"}</button></div>}
      {recipeMenuCursor && canAdjustStock && <div className="vendor-load-more"><button type="button" className="secondary-button" onClick={() => void loadMoreRecipeMenuItems()} disabled={recipeLoadingMore}>{recipeLoadingMore ? "Loading…" : "Load more menu items"}</button></div>}
      <p className="recipe-scope-note">Recipes are outlet-specific. Saving a BOM does not deduct stock from sales yet; the sale policy and reversible stock movement flow are still pending.</p>
    </section>
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

export function CloudReportsPage({ outletId, canViewFinancials, canViewGst, canViewShiftReports }: { outletId: string; canViewFinancials: boolean; canViewGst: boolean; canViewShiftReports: boolean }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [report, setReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const today = currentIndiaDate();
    setFrom((value) => value || today);
    setTo((value) => value || today);
  }, []);

  useEffect(() => {
    if (!outletId || !from || !to) return;
    let active = true;
    setLoading(true);
    setError("");
    setReport(null);
    void readJson<SalesReport>(`/api/reports/sales?outletId=${encodeURIComponent(outletId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((result) => { if (active) setReport(result); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Reports could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [outletId, from, to]);

  async function downloadCsv() {
    if (!outletId || !from || !to || from > to) return;
    setExporting(true);
    setError("");
    try {
      const response = await apiFetch(`/api/reports/sales?outletId=${encodeURIComponent(outletId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=csv`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Report export failed (${response.status}).`);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `kora-sales-${from}-to-${to}.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Report export failed.");
    } finally {
      setExporting(false);
    }
  }

  const invalidRange = !from || !to || from > to;
  return <>
    <div className="page-title-row"><div><p className="eyebrow">INSIGHTS · OUTLET DATA</p><h1>Reports</h1><p className="muted">Bill totals use issue date. Payment and refund activity use their recorded dates. Times are India Standard Time.</p></div><button className="secondary-button" disabled={loading || exporting || invalidRange || !report} onClick={() => void downloadCsv()}><Download size={15} />{exporting ? "Preparing…" : "Export CSV"}</button></div>
    <section className="card report-controls" aria-label="Report date range">
      <label><CalendarDays size={15} /> From <input aria-label="Report start date" type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
      <label><CalendarDays size={15} /> To <input aria-label="Report end date" type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
      <span>Up to 93 days · voided orders excluded</span>
    </section>
    {error && <div className="cloud-data-notice" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
    {invalidRange && <div className="cloud-data-notice" role="alert"><AlertTriangle size={16} /><span>Choose a valid start and end date.</span></div>}
    {loading && <div className="card report-loading" role="status"><RefreshCw size={18} className="spinning" /> Loading outlet report…</div>}
    {!loading && report && <>
      <div className="stats-grid report-metrics">
        <div className="card cloud-metric"><span>Bills issued</span><b>{report.summary.billCount.toLocaleString("en-IN")}</b><small>Non-voided bills in the selected period</small></div>
        {canViewFinancials && report.financials && <>
          <div className="card cloud-metric"><span>Billed total</span><b>{formatReportPaise(report.financials.billedTotalPaise)}</b><small>Includes GST and service charge</small></div>
          <div className="card cloud-metric"><span>Discounts</span><b>{formatReportPaise(report.financials.discountPaise)}</b><small>Saved bill discounts</small></div>
          <div className="card cloud-metric"><span>Service charge</span><b>{formatReportPaise(report.financials.serviceChargePaise)}</b><small>Included in the billed total</small></div>
        </>}
      </div>
      {report.summary.billCount === 0 ? <div className="card empty-state report-empty"><Activity size={23} /><b>No bills in this period</b><span>Choose another date range to view outlet activity.</span></div> : <div className="report-panels">
        {report.daily.length > 0 && <section className="card content-card"><div className="card-heading"><div><h2>Daily billed totals</h2><p>By bill issue date · {report.range.timeZone}</p></div></div><div className="wide-table report-table"><div className="table-head"><span>DATE</span><span>BILLS</span><span>TOTAL</span></div>{report.daily.map((day) => <div className="table-row" key={day.date}><span>{day.date}</span><span>{day.billCount.toLocaleString("en-IN")}</span><span>{canViewFinancials ? formatReportPaise(day.totalPaise) : "—"}</span></div>)}</div></section>}
        <section className="card content-card"><div className="card-heading"><div><h2>Top items</h2><p>Line sales after discounts, before GST and service charge</p></div></div>{report.topItems.length ? <div className="wide-table report-table"><div className="table-head"><span>ITEM</span><span>QUANTITY</span><span>LINE SALES</span></div>{report.topItems.map((item, index) => <div className="table-row" key={`${item.name}-${index}`}><span>{item.name}</span><span>{new Intl.NumberFormat("en-IN").format(BigInt(item.quantity))}</span><span>{canViewFinancials ? formatReportPaise(item.salesPaise) : "—"}</span></div>)}</div> : <div className="empty-state">No item lines were recorded in this period.</div>}</section>
        {canViewFinancials && <section className="card content-card"><div className="card-heading"><div><h2>Payment activity</h2><p>Captured payments recorded during the selected dates</p></div></div>{report.paymentActivity?.length ? <div className="wide-table report-table"><div className="table-head"><span>METHOD</span><span>ACTIVITY</span><span>AMOUNT</span></div>{report.paymentActivity.map((entry) => <div className="table-row" key={entry.method}><span>{entry.method}</span><span>Captured</span><span>{formatReportPaise(entry.amountPaise)}</span></div>)}</div> : <div className="empty-state">No payments were recorded in this period.</div>}
          <div className="card-heading report-subheading"><div><h2>Refund activity</h2><p>Recorded refunds, shown separately from bill issue totals</p></div></div>{report.refundActivity?.length ? <div className="wide-table report-table"><div className="table-head"><span>METHOD</span><span>ACTIVITY</span><span>AMOUNT</span></div>{report.refundActivity.map((entry) => <div className="table-row" key={entry.method}><span>{entry.method}</span><span>Refunded</span><span>{formatReportPaise(entry.amountPaise)}</span></div>)}</div> : <div className="empty-state">No refunds were recorded in this period.</div>}
        </section>}
        {canViewGst && <section className="card content-card"><div className="card-heading"><div><h2>GST summary</h2><p>Stored bill tax buckets · reference only, not a GST return</p></div></div>{report.gstSummary?.length ? <div className="wide-table report-table gst-report-table"><div className="table-head"><span>DOCUMENT / PROFILE</span><span>TAXABLE</span><span>CGST</span><span>SGST</span><span>IGST</span></div>{report.gstSummary.map((entry) => <div className="table-row" key={`${entry.documentType}-${entry.gstProfile}`}><span>{entry.documentType.replaceAll("_", " ")} · {entry.gstProfile.replaceAll("_", " ")}</span><span>{formatReportPaise(entry.taxablePaise)}</span><span>{formatReportPaise(entry.cgstPaise)}</span><span>{formatReportPaise(entry.sgstPaise)}</span><span>{formatReportPaise(entry.igstPaise)}</span></div>)}</div> : <div className="empty-state">No GST documents were issued in this period.</div>}</section>}
      </div>}
      <p className="report-footnote">Reports aggregate saved bills and payment ledgers on the server. Refunds appear by refund date; voided orders are excluded from bill totals. GST summary is a reconciliation aid and is not filing output.</p>
    </>}
    {canViewShiftReports && <CloudShiftReports outletId={outletId} from={from} to={to} />}
  </>;
}

function CloudShiftReports({ outletId, from, to }: { outletId: string; from: string; to: string }) {
  const requestGeneration = useRef(0);
  const [report, setReport] = useState<ShiftReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!outletId || !from || !to || from > to) return;
    const generation = ++requestGeneration.current;
    let active = true;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    setReport(null);
    const query = new URLSearchParams({ outletId, from, to, limit: "50" });
    void readJson<ShiftReport>(`/api/reports/shifts?${query}`)
      .then((result) => { if (active && generation === requestGeneration.current) setReport(result); })
      .catch((reason) => { if (active && generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : "Shift reports could not be loaded."); })
      .finally(() => { if (active && generation === requestGeneration.current) setLoading(false); });
    return () => { active = false; };
  }, [outletId, from, to]);

  async function loadMore() {
    if (!report?.nextCursor || loadingMore) return;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    setError("");
    const query = new URLSearchParams({ outletId, from, to, limit: "50", cursor: report.nextCursor });
    try {
      const next = await readJson<ShiftReport>(`/api/reports/shifts?${query}`);
      if (generation === requestGeneration.current) {
        setReport((current) => current ? { ...next, rows: [...current.rows, ...next.rows] } : next);
      }
    } catch (reason) {
      if (generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : "More shifts could not be loaded.");
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false);
    }
  }

  async function exportVisibleRows() {
    if (!report?.rows.length) return;
    setExporting(true);
    try {
      const cell = (value: unknown) => {
        let text = String(value ?? "");
        if (/^[\t\r ]*[=+@-]/.test(text)) text = `'${text}`;
        return `"${text.replaceAll('"', '""')}"`;
      };
      const columns = ["shift_id", "cashier", "status", "opened_at", "closed_at", "opening_cash_paise", "cash_captured_paise", "cash_refunded_paise", "expected_cash_paise", "counted_cash_paise", "variance_paise", "payment_totals", "refund_totals", "ledger_matches_close"];
      const lines = [columns, ...report.rows.map((row) => [row.id, row.cashierName, row.status, row.openedAt, row.closedAt, row.openingCashPaise, row.cashCapturedPaise, row.cashRefundedPaise, row.expectedCashPaise, row.countedCashPaise, row.variancePaise, row.payments.map((entry) => `${entry.method}:${entry.amountPaise}`).join("; "), row.refunds.map((entry) => `${entry.method}:${entry.amountPaise}`).join("; "), row.ledgerMatchesClose])]
        .map((line) => line.map(cell).join(",")).join("\r\n");
      const objectUrl = URL.createObjectURL(new Blob([`\uFEFF${lines}`], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `kora-shifts-visible-${from}-to-${to}.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      setError("Shift export could not be prepared.");
    } finally {
      setExporting(false);
    }
  }

  const time = (value: string | null) => value ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Open";
  const details = (entries: ShiftReportRow["payments"]) => entries.length ? entries.map((entry) => `${entry.method} ${formatReportPaise(entry.amountPaise)}`).join(" · ") : "—";

  return <section className="card content-card shift-report-card">
    <div className="card-heading shift-report-heading"><div><h2>Shift reconciliation</h2><p>Outlet shifts opened during {from}–{to} · values are server ledger totals</p></div><button className="secondary-button" disabled={exporting || !report?.rows.length} onClick={() => void exportVisibleRows()}><Download size={14} />{exporting ? "Preparing…" : "Export visible CSV"}</button></div>
    {error && <div className="cloud-data-notice" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
    {loading && <div className="report-loading" role="status"><RefreshCw size={17} className="spinning" /> Loading shift reconciliation…</div>}
    {!loading && report?.rows.length === 0 && <div className="empty-state report-empty"><Clock3 size={22} /><b>No shifts in this period</b><span>Shift history appears after a cashier opens or closes a shift.</span></div>}
    {!loading && report && report.rows.length > 0 && <div className="wide-table shift-report-table" role="table" aria-label="Shift reconciliation report">
      <div className="table-head" role="row"><span role="columnheader">SHIFT / CASHIER</span><span role="columnheader">OPENING</span><span role="columnheader">CASH IN</span><span role="columnheader">CASH REFUNDED</span><span role="columnheader">EXPECTED CASH</span><span role="columnheader">COUNTED</span><span role="columnheader">VARIANCE</span><span role="columnheader">PAYMENTS</span><span role="columnheader">STATUS</span></div>
      {report.rows.map((row) => <div className="table-row" role="row" key={row.id}>
        <span role="cell"><b>{row.cashierName}</b><small>{time(row.openedAt)} · {row.closedAt ? time(row.closedAt) : "still open"}</small>{!row.ledgerMatchesClose && <em className="shift-ledger-warning">Ledger differs from saved close</em>}</span>
        <span role="cell">{formatReportPaise(row.openingCashPaise)}</span><span role="cell">{formatReportPaise(row.cashCapturedPaise)}</span><span role="cell">{formatReportPaise(row.cashRefundedPaise)}</span><span role="cell">{formatReportPaise(row.expectedCashPaise)}</span>
        <span role="cell">{row.countedCashPaise === null ? "—" : formatReportPaise(row.countedCashPaise)}</span><span role="cell" className={row.variancePaise && BigInt(row.variancePaise) < 0n ? "shift-variance-negative" : ""}>{row.variancePaise === null ? "—" : formatReportPaise(row.variancePaise)}</span>
        <span role="cell" className="shift-payment-breakdown"><small>{details(row.payments)}</small>{row.refunds.length > 0 && <small>Refunds: {details(row.refunds)}</small>}</span><span role="cell"><i className={`shift-status ${row.status.toLowerCase()}`}>{row.status}</i></span>
      </div>)}
      <div className="shift-report-footer"><span>Showing {report.rows.length.toLocaleString("en-IN")} shift{report.rows.length === 1 ? "" : "s"}. Export includes visible rows only.</span>{report.nextCursor && <button className="secondary-button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more shifts"}</button>}</div>
    </div>}
    <p className="report-footnote">Expected cash = opening float + recorded cash payments − recorded cash refunds. Open-shift expected cash is live; completed shifts retain the amount recorded at close. Refund totals include refunds explicitly linked to that shift; non-cash refunds without a shift link appear in outlet-level payment activity instead. The warning indicates later ledger activity differs from the close snapshot.</p>
  </section>;
}
