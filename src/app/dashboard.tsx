"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight,
  BadgeIndianRupee, BarChart3, Bell, BookOpen, Box, CalendarDays, Check,
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3,
  Command, CreditCard, Download, Ellipsis, FileDown, Filter, Flame, Gift,
  Grid2X2, Headphones, House, IndianRupee, LayoutDashboard, ListFilter, LogOut,
  Menu, Minus, MoreHorizontal, Package, Plus, Printer, Search, Settings,
  ShieldCheck, ShoppingBag, ShoppingCart, SlidersHorizontal, Sparkles,
  Star, Store, Tag, TrendingUp, Truck, UserRound, Users, Wallet, Wifi,
  WifiOff, X, Zap,
} from "lucide-react";
import { calculateSale, parseRupeesToPaise } from "@/lib/billing";
import { io } from "socket.io-client";
import { ApiError, getAccessToken, hasPendingLogout, readJson, readSession, registerRestaurant, restoreSession, signIn, signOut, type AuthenticatedSession } from "@/lib/client-api";
import { cacheMenu, cacheOfflineWorkspace, cacheTables, clearOfflineWorkspace, getDeviceId, getPendingOrders, queueOrder, readCachedMenu, readOfflineWorkspace, removePendingOrder, updatePendingOrderError, type CachedDisplayOrder, type CloudOrderPayload } from "@/lib/pos-offline";
import { allPermissionKeys, systemRolePermissions, type PermissionKey } from "@/lib/permissions";
import { filterOfflinePermissions, hasFreshOfflinePermissionSnapshot, OFFLINE_PERMISSION_TTL_MS } from "@/lib/offline-permissions";
import { RoleAdministration } from "@/components/RoleAdministration";
import { AuditLogViewer } from "@/components/AuditLogViewer";
import { OutletApprovalSettings } from "@/components/OutletApprovalSettings";
import { OutletProfileSettings } from "@/components/OutletProfileSettings";
import { BuyerInvoiceDetailsForm, type BuyerInvoiceDraft } from "@/components/BuyerInvoiceDetailsForm";
import { InvoicePrintDocument, type InvoicePrintData } from "@/components/InvoicePrintDocument";
import { OfflinePrintDocument } from "@/components/OfflinePrintDocument";
import { CloudCustomersPage, CloudInventoryPage, CloudOverview, CloudReportsPage } from "@/components/CloudWorkspaceViews";

type Page = "Overview" | "POS" | "Orders" | "Kitchen" | "Kitchen Display" | "Menu" | "Inventory" | "Customers" | "Team" | "Reports" | "Audit" | "Settings";
type Product = { id: string; name: string; category: string; categoryId?: string; price: number; gstBps?: number; taxCodeKind?: "HSN" | "SAC" | null; taxCode?: string | null; color: string; emoji: string; stock?: number; available: boolean };
type CartLine = { id: string; productId: string; name: string; price: number; gstBps?: number; qty: number; note?: string };
type OrderPayment = { id: string; method: string; amountPaise: number; refundedPaise: number; refundablePaise: number };
type Order = CachedDisplayOrder & { serverId?: string; tableId?: string; paymentStatus?: string; payments?: OrderPayment[]; gstAmount?: number; invoiceBillId?: string; invoiceNumber?: string; invoiceDocumentType?: string; supplierGstin?: string };
type Customer = { id?: string; name: string; phone: string; visits: number; spend: number };
type RestaurantTable = { id: string; label: string; section?: string | null; capacity: number; occupied?: boolean };
type AppData = { products: Product[]; orders: Order[]; customers: Customer[]; shiftOpen: boolean; cashOpen: number; language: string; serviceChargeBps: number };

const knownPermissionKeys = new Set<string>(allPermissionKeys);
function cachedOfflinePermissions(permissions?: string[]): PermissionKey[] {
  return filterOfflinePermissions(permissions, knownPermissionKeys) as PermissionKey[];
}

const paiseToRupees = (value: unknown) => Number(value ?? 0) / 100;
const serverType = (value: string) => ({ DINE_IN: "Dine in", TAKEAWAY: "Takeaway", DELIVERY: "Delivery", QR: "Delivery", AGGREGATOR: "Delivery" } as Record<string, string>)[value] ?? value;
const serverStatus = (value: string) => ({ OPEN: "Preparing", SENT: "Preparing", PREPARING: "Preparing", READY: "Ready", SERVED: "Served", COMPLETED: "Completed", CANCELLED: "Cancelled" } as Record<string, string>)[value] ?? value;

function mapCloudMenu(categories: Array<{ id: string; name: string; items: Array<Record<string, unknown>> }>): Product[] {
  const colors = ["peach", "sage", "pink", "yellow", "lavender"];
  return categories.flatMap((category) => category.items.map((raw, index) => {
    const prices = Array.isArray(raw.outletPrices) ? raw.outletPrices as Array<Record<string, unknown>> : [];
    const price = prices[0]?.pricePaise ?? raw.basePricePaise ?? 0;
    return {
      id: String(raw.id), name: String(raw.name), category: category.name, categoryId: category.id,
      price: paiseToRupees(price), gstBps: Number(raw.gstBps ?? 500), taxCodeKind: raw.taxCodeKind === "HSN" || raw.taxCodeKind === "SAC" ? raw.taxCodeKind : null, taxCode: typeof raw.taxCode === "string" ? raw.taxCode : null, color: colors[index % colors.length], emoji: raw.isVeg === false ? "🍗" : "🍽️",
      available: prices[0]?.available !== false,
    };
  }));
}

function mapCloudOrder(raw: Record<string, unknown>): Order {
  const rawItems = Array.isArray(raw.items) ? raw.items as Array<Record<string, unknown>> : [];
  const rawBill = raw.bill && typeof raw.bill === "object" ? raw.bill as Record<string, unknown> : {};
  const payments = Array.isArray(rawBill.payments) ? rawBill.payments as Array<Record<string, unknown>> : [];
  const grossPaidPaise = payments.filter((p) => p.status === "PAID").reduce((sum, p) => sum + Number(p.amountPaise ?? 0), 0);
  const refundedPaise = payments.reduce((sum, payment) => {
    const reversals = Array.isArray(payment.reversals) ? payment.reversals as Array<Record<string, unknown>> : [];
    return sum + reversals.reduce((paymentSum, reversal) => paymentSum + Number(reversal.amountPaise ?? 0), 0);
  }, 0);
  const displayPayments = payments.filter((payment) => payment.status === "PAID").map((payment) => {
    const reversals = Array.isArray(payment.reversals) ? payment.reversals as Array<Record<string, unknown>> : [];
    const amountPaise = Number(payment.amountPaise ?? 0);
    const refunded = reversals.reduce((sum, reversal) => sum + Number(reversal.amountPaise ?? 0), 0);
    return { id: String(payment.id), method: String(payment.method), amountPaise, refundedPaise: refunded, refundablePaise: Math.max(0, amountPaise - refunded) };
  });
  const paidPaise = Math.max(0, grossPaidPaise - refundedPaise);
  const fullyRefunded = rawBill.paymentStatus === "REFUNDED";
  const gstAmount = Number(rawBill.cgstPaise ?? 0) + Number(rawBill.sgstPaise ?? 0) + Number(rawBill.igstPaise ?? 0);
  const total = paiseToRupees(raw.totalPaise);
  const table = raw.table && typeof raw.table === "object" ? raw.table as Record<string, unknown> : null;
  const customer = raw.customer && typeof raw.customer === "object" ? raw.customer as Record<string, unknown> : null;
  const method = payments[0]?.method;
  return {
    id: `K-${String(raw.orderNumber ?? "").padStart(4, "0")}`, serverId: String(raw.id), tableId: typeof raw.tableId === "string" ? raw.tableId : undefined,
    items: rawItems.map((line) => ({ id: String(line.id), productId: String(line.menuItemId), name: String(line.nameSnapshot), price: paiseToRupees(line.unitPricePaise), qty: Number(line.quantity), note: typeof line.notes === "string" ? line.notes : undefined })),
    type: serverType(String(raw.type)), table: typeof table?.label === "string" ? table.label : "—", total, status: serverStatus(String(raw.status)),
    time: new Date(String(raw.createdAt)).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }),
    payment: fullyRefunded ? "Refunded" : paidPaise === 0 ? "Pending" : paidPaise < Number(raw.totalPaise ?? 0) ? "Partial" : ({ CASH: "Cash", CARD: "Card", UPI: "UPI", OTHER: "Other" } as Record<string, string>)[String(method)] ?? "Paid",
    paidAmount: paiseToRupees(paidPaise), customer: typeof customer?.name === "string" ? customer.name : typeof rawBill.recipientNameSnapshot === "string" ? rawBill.recipientNameSnapshot : "Walk-in", paymentStatus: typeof rawBill.paymentStatus === "string" ? rawBill.paymentStatus : undefined, payments: displayPayments,
    gstAmount: paiseToRupees(gstAmount), invoiceNumber: typeof rawBill.invoiceNumber === "string" ? rawBill.invoiceNumber : undefined,
    invoiceBillId: typeof rawBill.id === "string" ? rawBill.id : undefined,
    invoiceDocumentType: typeof rawBill.documentType === "string" ? rawBill.documentType : undefined,
    supplierGstin: typeof rawBill.gstinSnapshot === "string" ? rawBill.gstinSnapshot : undefined,
  };
}

const initialProducts: Product[] = [
  { id: "p1", name: "Masala Dosa", category: "Breakfast", price: 180, color: "peach", emoji: "🥞", available: true },
  { id: "p2", name: "Idli Sambar", category: "Breakfast", price: 120, color: "sage", emoji: "🍛", available: true },
  { id: "p3", name: "Paneer Tikka", category: "Starters", price: 280, color: "pink", emoji: "🧀", available: true },
  { id: "p4", name: "Crispy Corn", category: "Starters", price: 220, color: "yellow", emoji: "🌽", available: true },
  { id: "p5", name: "Butter Chicken", category: "Mains", price: 390, color: "peach", emoji: "🍗", available: true },
  { id: "p6", name: "Dal Makhani", category: "Mains", price: 290, color: "lavender", emoji: "🫘", available: true },
  { id: "p7", name: "Butter Naan", category: "Breads", price: 60, color: "yellow", emoji: "🫓", available: true },
  { id: "p8", name: "Garlic Naan", category: "Breads", price: 80, color: "sage", emoji: "🫓", available: true },
  { id: "p9", name: "Mango Lassi", category: "Drinks", price: 140, color: "yellow", emoji: "🥭", available: true },
  { id: "p10", name: "Filter Coffee", category: "Drinks", price: 90, color: "peach", emoji: "☕", available: true },
];

const seed: AppData = {
  products: initialProducts,
  orders: [
    { id: "K-1048", items: [{ id: "x1", productId: "p1", name: "Masala Dosa", price: 180, qty: 1 }], type: "Dine in", table: "T-04", total: 189, status: "Served", time: "12:42 PM", payment: "UPI", customer: "Walk-in" },
    { id: "K-1047", items: [{ id: "x2", productId: "p5", name: "Butter Chicken", price: 390, qty: 1 }], type: "Takeaway", table: "—", total: 409.5, status: "Preparing", time: "12:38 PM", payment: "Pending", customer: "Aarav Shah" },
    { id: "K-1046", items: [{ id: "x3", productId: "p2", name: "Idli Sambar", price: 120, qty: 2 }], type: "Dine in", table: "T-08", total: 252, status: "Ready", time: "12:31 PM", payment: "Cash", customer: "Walk-in" },
    { id: "K-1045", items: [{ id: "x4", productId: "p3", name: "Paneer Tikka", price: 280, qty: 1 }], type: "Delivery", table: "—", total: 294, status: "Served", time: "12:24 PM", payment: "Card", customer: "Meera Nair" },
  ],
  customers: [
    { name: "Aarav Shah", phone: "+91 98765 43210", visits: 12, spend: 8640 },
    { name: "Meera Nair", phone: "+91 98450 12345", visits: 8, spend: 5320 },
    { name: "Kabir Mehta", phone: "+91 98203 45678", visits: 6, spend: 3910 },
    { name: "Ananya Rao", phone: "+91 99001 23456", visits: 4, spend: 2480 },
  ], shiftOpen: true, cashOpen: 5000, language: "English", serviceChargeBps: 0,
};

const fmt = (amount: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
const navItems: { label: Page; icon: typeof House; group: string }[] = [
  { label: "Overview", icon: LayoutDashboard, group: "Workspace" }, { label: "POS", icon: ShoppingCart, group: "Workspace" },
  { label: "Orders", icon: BookOpen, group: "Workspace" }, { label: "Kitchen", icon: Flame, group: "Workspace" }, { label: "Kitchen Display", icon: Flame, group: "Workspace" }, { label: "Menu", icon: Grid2X2, group: "Manage" },
  { label: "Inventory", icon: Package, group: "Manage" }, { label: "Customers", icon: Users, group: "Manage" },
  { label: "Team", icon: ShieldCheck, group: "Manage" }, { label: "Reports", icon: BarChart3, group: "Insights" }, { label: "Audit", icon: ShieldCheck, group: "Insights" },
  { label: "Settings", icon: Settings, group: "Insights" },
];
const initials = (s: string) => s.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
const offlineQueueReadError = "Offline orders could not be read from this device. Keep this browser profile and retry; do not clear site storage.";
const cloudOrdersRefreshError = "Cloud orders could not be refreshed. Check the connection; saved orders remain on the server or this device.";

export default function Home() {
  const [data, setData] = useState<AppData>(seed);
  const latestData = useRef(data);
  latestData.current = data;
  const demoSnapshot = useRef<AppData | null>(null);
  const offlineQueueWarningNotified = useRef(false);
  const [cloudSession, setCloudSession] = useState<AuthenticatedSession | null>(null);
  const [offlineOnly, setOfflineOnly] = useState(false);
  const [selectedOutletId, setSelectedOutletId] = useState("");
  const [cloudTables, setCloudTables] = useState<RestaurantTable[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudSaving, setCloudSaving] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [cloudError, setCloudError] = useState("");
  const [offlinePermissionExpiresAt, setOfflinePermissionExpiresAt] = useState<number | null>(null);
  const [invoiceDocument, setInvoiceDocument] = useState<InvoicePrintData | null>(null);
  const [offlinePrint, setOfflinePrint] = useState<{ order: Order; mode: "receipt" | "kot" } | null>(null);
  const [loginInput, setLoginInput] = useState({ tenantSlug: "", email: "", password: "" });
  const [registerInput, setRegisterInput] = useState({ tenantName: "", outletName: "", name: "", email: "", password: "" });
  const [authMode, setAuthMode] = useState<"signin" | "register">("signin");
  const [page, setPage] = useState<Page>("Overview");
  const [demoRole, setDemoRole] = useState<keyof typeof systemRolePermissions>("OWNER");
  const [online, setOnline] = useState(true);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState<"payment" | "additem" | "customer" | "shift" | "openShift" | "connect" | "outlet" | "" > ("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [category, setCategory] = useState("All items");
  const [orderType, setOrderType] = useState("Dine in");
  const [table, setTable] = useState("T-04");
  const [discount, setDiscount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState("UPI");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [buyerDetails, setBuyerDetails] = useState<BuyerInvoiceDraft>({ name: "", gstin: "", address: { line1: "", line2: "", city: "", state: "", pincode: "" } });
  const [showBuyerDetails, setShowBuyerDetails] = useState(false);
  const [paymentValue, setPaymentValue] = useState("");
  const [cashCounted, setCashCounted] = useState("");
  const [openingCash, setOpeningCash] = useState("");
  const [newItem, setNewItem] = useState({ name: "", category: "Mains", price: "" });
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "" });
  const [range, setRange] = useState("Today");
  const cloudMode = Boolean(cloudSession && selectedOutletId);
  const currentOutlet = cloudSession?.outlets.find((outlet) => outlet.id === selectedOutletId);
  const effectivePermissions = cloudMode ? currentOutlet?.permissions ?? [] : systemRolePermissions[demoRole];
  const syncLabel = cloudMode
    ? (cloudError
      ? (online ? "Cloud · sync attention" : "Offline · attention")
      : (online ? `Cloud · ${pendingCount ? `${pendingCount} pending` : "synced"}` : `Offline · ${pendingCount} queued`))
    : (online ? "Local demo mode" : "Working offline");
  const canSettleBills = effectivePermissions.includes("bills.settle");
  const canRefundBills = effectivePermissions.includes("bills.refund");
  const canEditMenu = effectivePermissions.includes("menu.edit");
  const canEditTax = effectivePermissions.includes("menu.tax_edit");
  const canManageCustomers = effectivePermissions.includes("customers.manage");
  const canAccessPage = (label: Page) => {
    const access: Record<Page, string[]> = {
      Overview: ["orders.read", "reports.view.sales", "reports.view.financial", "shift.open", "kds.view", "inventory.view"],
      POS: ["orders.create"], Orders: ["orders.read", "reports.view.sales", "kds.view"], Kitchen: ["kds.view"], "Kitchen Display": ["kds.view"],
      Menu: ["menu.view"], Inventory: ["inventory.view"], Customers: ["customers.view"], Team: ["staff.manage", "roles.manage"],
      Reports: ["reports.view.sales", "reports.view.financial", "reports.view.gst", "reports.view.staff_performance", "reports.view.kds_sla"],
      Audit: ["audit.view"], Settings: ["settings.manage", "outlets.manage"],
    };
    return access[label].some((permission) => effectivePermissions.includes(permission));
  };

  useEffect(() => {
    if (!selectedCustomerId) return;
    const selected = data.customers.find((customer) => customer.id === selectedCustomerId);
    if (selected?.name) setBuyerDetails((current) => ({ ...current, name: current.name || selected.name }));
  }, [data.customers, selectedCustomerId]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("kora-demo-v1");
      if (saved) {
        const restored = JSON.parse(saved) as Partial<AppData>;
        const migratedProducts = restored.products?.filter((product) => !["p11", "p12"].includes(product.id));
        setData({ ...seed, ...restored, ...(migratedProducts ? { products: migratedProducts } : {}) });
      }
    } catch { setNotice("Saved demo data could not be read. The bundled sample menu is loaded instead."); }
    const update = () => setOnline(navigator.onLine);
    update(); window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  useEffect(() => { if (!cloudMode) try { localStorage.setItem("kora-demo-v1", JSON.stringify(data)); } catch { setNotice("This device could not save the latest demo changes. Free storage before continuing."); } }, [data, cloudMode]);
  useEffect(() => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => setNotice("Offline app-shell caching is unavailable in this browser.")); }, []);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(""), 2800); return () => clearTimeout(t); }, [notice]);

  const notify = (text: string) => setNotice(text);
  const saveOfflineWorkspace = async (workspace: Parameters<typeof cacheOfflineWorkspace>[0]) => {
    await cacheOfflineWorkspace(workspace);
    setOfflinePermissionExpiresAt(Date.now() + OFFLINE_PERMISSION_TTL_MS);
  };
  const readPendingOrders = async (outletId: string) => {
    try {
      const orders = await getPendingOrders(outletId);
      offlineQueueWarningNotified.current = false;
      setCloudError((current) => current === offlineQueueReadError ? "" : current);
      return orders;
    } catch {
      setCloudError(offlineQueueReadError);
      if (!offlineQueueWarningNotified.current) notify(offlineQueueReadError);
      offlineQueueWarningNotified.current = true;
      throw new Error(offlineQueueReadError);
    }
  };
  const refreshCloudOrders = async (outletId: string) => {
    try {
      const [rawOrders, pendingOrders] = await Promise.all([
        readJson<Array<Record<string, unknown>>>(`/api/orders?outletId=${encodeURIComponent(outletId)}`),
        readPendingOrders(outletId),
      ]);
      const queued = pendingOrders.map((item) => ({ ...item.displayOrder, syncState: item.lastError ? "needs-attention" as const : "queued" as const }));
      setPendingCount(pendingOrders.length);
      setData((current) => ({ ...current, orders: [...queued, ...rawOrders.map(mapCloudOrder)] }));
      setCloudError((current) => current === cloudOrdersRefreshError ? "" : current);
    } catch (error) {
      if (!(error instanceof Error && error.message === offlineQueueReadError)) setCloudError(cloudOrdersRefreshError);
      throw error;
    }
  };
  const loadCloudOutlet = async (outletId: string, permissions: string[]) => {
    if (!outletId) return;
    setCloudLoading(true); setCloudError("");
    try {
      const cached = await readCachedMenu(outletId).catch(() => undefined);
      if (offlineOnly && !navigator.onLine) {
        let pending: Awaited<ReturnType<typeof getPendingOrders>> | null = null;
        try { pending = await readPendingOrders(outletId); } catch { /* The queue warning is visible; cached menu browsing can continue. */ }
        if (!cached?.categories) setCloudError("This outlet menu is not available in this device's offline cache. Reconnect before taking orders.");
        setData((current) => ({
          ...current,
          products: cached?.categories ? mapCloudMenu(cached.categories as Array<{ id: string; name: string; items: Array<Record<string, unknown>> }>) : [],
          serviceChargeBps: cached?.serviceChargeBps ?? 0, customers: [], shiftOpen: false,
          orders: pending?.map((item) => ({ ...item.displayOrder, syncState: item.lastError ? "needs-attention" as const : "queued" as const })) ?? [],
        }));
        setCloudTables(cached?.tables ?? []);
        if (pending) setPendingCount(pending.length);
        setCloudLoading(false); return;
      }
      if (cached?.categories) setData((current) => ({ ...current, products: mapCloudMenu(cached.categories as Array<{ id: string; name: string; items: Array<Record<string, unknown>> }>) }));
      const jobs = await Promise.allSettled([
        permissions.includes("menu.view") ? readJson<Array<{ id: string; name: string; items: Array<Record<string, unknown>> }>>(`/api/menu?outletId=${encodeURIComponent(outletId)}`) : Promise.resolve([]),
        (permissions.includes("orders.read") || permissions.includes("reports.view.sales") || permissions.includes("kds.view")) ? refreshCloudOrders(outletId) : Promise.resolve([]),
        (permissions.includes("orders.create") || permissions.includes("orders.read")) ? readJson<{ tables: RestaurantTable[]; serviceChargeBps: number }>(`/api/tables?outletId=${encodeURIComponent(outletId)}`) : Promise.resolve({ tables: [], serviceChargeBps: 0 }),
        permissions.includes("shift.open") ? readJson<{ shift: Record<string, unknown> | null }>(`/api/shifts?outletId=${encodeURIComponent(outletId)}`) : Promise.resolve(null),
        permissions.includes("customers.view") ? readJson<Array<Record<string, unknown>>>(`/api/customers?outletId=${encodeURIComponent(outletId)}`) : Promise.resolve(null),
      ]);
      const menuResult = jobs[0];
      if (menuResult.status === "fulfilled") {
        await cacheMenu(outletId, menuResult.value).catch(() => undefined);
        setData((current) => ({ ...current, products: mapCloudMenu(menuResult.value) }));
      } else if (!cached) throw menuResult.reason;
      const tableResult = jobs[2];
      if (tableResult.status === "fulfilled") {
        setCloudTables(tableResult.value.tables);
        setTable((current) => tableResult.value.tables.some((item) => item.label === current && !item.occupied) ? current : tableResult.value.tables.find((item) => !item.occupied)?.label ?? "");
        setData((current) => ({ ...current, serviceChargeBps: tableResult.value.serviceChargeBps }));
        await cacheTables(outletId, tableResult.value.tables, tableResult.value.serviceChargeBps).catch(() => undefined);
      }
      if (jobs[3].status === "fulfilled" && jobs[3].value) {
        const shift = jobs[3].value.shift;
        setData((current) => ({ ...current, shiftOpen: Boolean(shift), cashOpen: shift ? paiseToRupees(shift.openingCashPaise) : 0 }));
      }
      if (jobs[4].status === "fulfilled" && jobs[4].value) {
        const customers = jobs[4].value.map((customer) => {
          const outlet = customer.outlet as Record<string, unknown> | null;
          return { id: String(customer.id), name: String(customer.name ?? "Guest"), phone: String(customer.phone ?? ""), visits: Number(outlet?.visits ?? 0), spend: paiseToRupees(outlet?.spendPaise) };
        });
        setData((current) => ({ ...current, customers }));
      }
      if (!permissions.includes("menu.view")) setData((current) => ({ ...current, products: [] }));
      if (!permissions.includes("orders.read") && !permissions.includes("reports.view.sales") && !permissions.includes("kds.view")) setData((current) => ({ ...current, orders: [] }));
      const activeOutlet = cloudSession?.outlets.find((item) => item.id === outletId);
      if (activeOutlet && cloudSession) void saveOfflineWorkspace({ userId: cloudSession.user.id, userName: cloudSession.user.name, outletId, outletName: activeOutlet.name, role: activeOutlet.role, permissions: activeOutlet.permissions }).catch(() => undefined);
      const failures = jobs.filter((result) => result.status === "rejected");
      if (failures.length) setCloudError("Some cloud data could not be refreshed. Check your connection or access permissions.");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Could not connect to this outlet.");
    } finally { setCloudLoading(false); }
  };
  const syncPendingOrders = async (outletId: string) => {
    if (!navigator.onLine || !outletId) return;
    let pending;
    try { pending = await readPendingOrders(outletId); }
    catch { return; }
    let synced = 0;
    for (const entry of pending) {
      if (entry.nextAttemptAt && entry.nextAttemptAt > Date.now()) continue;
      try {
        await readJson("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry.payload) });
        await removePendingOrder(entry.clientMutationId); synced++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sync failed.";
        const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);
        const retryCount = (entry.retryCount ?? 0) + 1;
        const nextAttemptAt = permanent ? Number.MAX_SAFE_INTEGER : Date.now() + Math.min(300000, 2000 * (2 ** Math.min(retryCount - 1, 7)));
        await updatePendingOrderError(entry.clientMutationId, message, retryCount, nextAttemptAt).catch(() => undefined);
        if (permanent) notify(`Offline order ${entry.displayOrder.id} needs attention: ${message}`);
        break;
      }
    }
    if (synced) notify(`${synced} offline ${synced === 1 ? "order" : "orders"} synced`);
    await refreshCloudOrders(outletId).catch(() => undefined);
  };
  const retryPendingOrder = async (order: Order) => {
    let pending;
    try { pending = await readPendingOrders(selectedOutletId); }
    catch { return; }
    const entry = pending.find((item) => item.displayOrder.id === order.id);
    if (!entry) return;
    await updatePendingOrderError(entry.clientMutationId, "", entry.retryCount ?? 0, 0);
    await syncPendingOrders(selectedOutletId);
  };

  useEffect(() => {
    let active = true;
    const restore = async () => {
      if (!navigator.onLine) {
        if (hasPendingLogout()) {
          setCloudError("A previous sign-out is waiting for a network connection. Reconnect before using this outlet.");
          setModal("connect");
          return;
        }
        const cached = await readOfflineWorkspace().catch(() => undefined);
        if (!active || !cached) return;
        const permissionSnapshotFresh = hasFreshOfflinePermissionSnapshot(cached.savedAt);
        const offlinePermissions = permissionSnapshotFresh ? cachedOfflinePermissions(cached.permissions) : [];
        setOfflinePermissionExpiresAt(permissionSnapshotFresh ? cached.savedAt + OFFLINE_PERMISSION_TTL_MS : null);
        setCloudError(permissionSnapshotFresh ? "" : "Offline billing access expired. Reconnect and sign in to settle bills; new orders remain provisional until server authorization.");
        demoSnapshot.current = latestData.current;
        setCloudSession({ user: { id: cached.userId, name: cached.userName, email: "" }, outlets: [{ id: cached.outletId, name: cached.outletName, role: cached.role, permissions: offlinePermissions }] });
        setSelectedOutletId(cached.outletId); setOfflineOnly(true); setPage("POS"); return;
      }
      const session = await restoreSession();
      if (!active || !session || !session.outlets.length) return;
      demoSnapshot.current = latestData.current;
      setOfflinePermissionExpiresAt(Date.now() + OFFLINE_PERMISSION_TTL_MS);
      setCloudError("");
      setCloudSession(session); setSelectedOutletId(session.outlets[0].id); setOfflineOnly(false); setPage("POS");
    };
    void restore();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!cloudMode || !currentOutlet) return;
    void loadCloudOutlet(selectedOutletId, currentOutlet.permissions);
    const handleOffline = () => setOfflineOnly(true);
    const refresh = () => {
      if (!navigator.onLine) return;
      void restoreSession().then((session) => {
        const outlet = session?.outlets.find((item) => item.id === selectedOutletId);
        if (!session || session.user.id !== cloudSession?.user.id || !outlet) {
          setCloudSession(null); setSelectedOutletId(""); setOfflineOnly(false); setOfflinePermissionExpiresAt(null);
          setCloudError("This session or outlet access is no longer valid. Sign in again to continue."); setModal("connect");
          return;
        }
        setCloudSession(session); setOfflineOnly(false); setCloudError("");
        void saveOfflineWorkspace({ userId: session.user.id, userName: session.user.name, outletId: outlet.id, outletName: outlet.name, role: outlet.role, permissions: outlet.permissions }).catch(() => undefined);
      }).catch(() => setCloudError("Session could not be revalidated. Offline actions remain provisional; sign in again when connected."));
      void syncPendingOrders(selectedOutletId);
      void refreshCloudOrders(selectedOutletId).catch(() => undefined);
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", refresh);
    const realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL ?? `${window.location.protocol}//${window.location.hostname}:4000`;
    const socket = io(realtimeUrl, { autoConnect: true, withCredentials: true, auth: { accessToken: getAccessToken(), outletId: selectedOutletId }, reconnection: true, reconnectionDelayMax: 10000 });
    const updateOrders = () => { void refreshCloudOrders(selectedOutletId).catch(() => undefined); };
    const updateShift = () => {
      if (!currentOutlet.permissions.includes("shift.open")) return;
      void readJson<{ shift: Record<string, unknown> | null }>(`/api/shifts?outletId=${encodeURIComponent(selectedOutletId)}`).then(({ shift }) => {
        setData((current) => ({ ...current, shiftOpen: Boolean(shift), cashOpen: shift ? paiseToRupees(shift.openingCashPaise) : 0 }));
      }).catch(() => undefined);
    };
    socket.on("order:new", updateOrders);
    socket.on("order:updated", updateOrders);
    socket.on("kot:status", updateOrders);
    socket.on("menu:updated", refresh);
    socket.on("shift:updated", updateShift);
    let refreshingSocketSession = false;
    socket.on("connect_error", (error) => {
      if (refreshingSocketSession || !/access token|authentication and outlet context/i.test(error.message)) return;
      refreshingSocketSession = true;
      void restoreSession().then((session) => {
        if (session && session.user.id === cloudSession?.user.id && session.outlets.some((outlet) => outlet.id === selectedOutletId)) {
          socket.auth = { accessToken: getAccessToken(), outletId: selectedOutletId };
          socket.connect();
        } else {
          setCloudError("Your cloud session expired. Sign in again."); setCloudSession(null); setSelectedOutletId(""); setModal("connect");
        }
      }).finally(() => { refreshingSocketSession = false; });
    });
    // The polling fallback recovers missed broadcasts and works when Redis fan-out is absent.
    const timer = window.setInterval(refresh, 30000);
    return () => { window.removeEventListener("offline", handleOffline); window.removeEventListener("online", refresh); window.clearInterval(timer); socket.removeAllListeners(); socket.disconnect(); };
  }, [cloudMode, selectedOutletId, currentOutlet?.id, offlineOnly]);

  useEffect(() => {
    if (!cloudMode || !offlineOnly || online || offlinePermissionExpiresAt === null) return;
    const expiresAt = offlinePermissionExpiresAt;
    const expirePermissions = () => {
      if (Date.now() < expiresAt) return;
      setCloudSession((session) => session ? {
        ...session,
        outlets: session.outlets.map((outlet) => outlet.id === selectedOutletId ? { ...outlet, permissions: [] } : outlet),
      } : session);
      setOfflinePermissionExpiresAt(null);
      setCloudError("Offline permission snapshot expired. Reconnect and sign in before continuing protected work.");
    };
    expirePermissions();
    const timer = window.setInterval(expirePermissions, 5000);
    document.addEventListener("visibilitychange", expirePermissions);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", expirePermissions); };
  }, [cloudMode, offlineOnly, online, offlinePermissionExpiresAt, selectedOutletId]);

  const categories = ["All items", ...Array.from(new Set(data.products.map((p) => p.category)))];
  const visibleProducts = useMemo(() => data.products.filter((p) => p.available && (category === "All items" || p.category === category) && p.name.toLowerCase().includes(query.toLowerCase())), [data.products, category, query]);
  const totals = cart.length ? calculateSale(cart.map((i) => ({ quantity: i.qty, unitPricePaise: Math.round(i.price * 100), gstBps: i.gstBps ?? 500 })), { discountPaise: Math.round(cart.reduce((s, i) => s + i.price * i.qty, 0) * 100 * discount / 100), serviceChargeBps: orderType === "Dine in" ? data.serviceChargeBps : 0 }) : { subtotalPaise: 0, taxPaise: 0, discountPaise: 0, serviceChargePaise: 0, totalPaise: 0 };
  const subtotal = totals.subtotalPaise / 100;
  const tax = totals.taxPaise / 100;
  const discountAmount = totals.discountPaise / 100;
  const total = totals.totalPaise / 100;
  const parsedPaymentPaise = useMemo(() => {
    if (!paymentValue.trim()) return null;
    try { return parseRupeesToPaise(paymentValue); } catch { return Number.NaN; }
  }, [paymentValue]);
  const cartQty = cart.reduce((s, i) => s + i.qty, 0);
  const todayOrders = data.orders.length + (cloudMode ? 0 : 42);
  const todaySales = data.orders.reduce((s, o) => s + o.total, 0) + (cloudMode ? 0 : 23680);

  const addToCart = (product: Product) => setCart((prev) => {
    const found = prev.find((i) => i.productId === product.id);
    return found ? prev.map((i) => i.productId === product.id ? { ...i, qty: i.qty + 1 } : i) : [...prev, { id: crypto.randomUUID(), productId: product.id, name: product.name, price: product.price, gstBps: product.gstBps ?? 500, qty: 1 }];
  });
  const changeQty = (id: string, by: number) => setCart((prev) => prev.map((i) => i.id === id ? { ...i, qty: i.qty + by } : i).filter((i) => i.qty > 0));
  const placeOrder = async (method: string) => {
    if (!cart.length) return;
    let receivedPaise: number;
    try { receivedPaise = method === "Pending" ? 0 : paymentValue.trim() ? parseRupeesToPaise(paymentValue) : totals.totalPaise; }
    catch { notify("Enter a valid amount with no more than two decimal places"); return; }
    if (receivedPaise > totals.totalPaise) { notify("Payment cannot exceed the bill total"); return; }
    const received = receivedPaise / 100;
    if (cloudMode && currentOutlet) {
      if (offlineOnly && method === "Cash" && receivedPaise > 0) { notify("Offline cash collection needs an open server shift. Record the bill as pending, then settle it after reconnecting."); return; }
      setCloudSaving(true);
      const clientMutationId = crypto.randomUUID();
      const selectedTable = cloudTables.find((item) => item.label === table);
      const payload: CloudOrderPayload = {
        outletId: selectedOutletId, clientMutationId, deviceId: (() => { try { return getDeviceId(); } catch { return crypto.randomUUID(); } })(),
         type: orderType as CloudOrderPayload["type"], ...(orderType === "Dine in" && selectedTable ? { tableId: selectedTable.id } : {}), ...(selectedCustomerId ? { customerId: selectedCustomerId } : {}), buyerDetails,
        items: cart.map((item) => ({ menuItemId: item.productId, quantity: item.qty, ...(item.note ? { note: item.note } : {}) })),
        paidPaise: receivedPaise, discountBps: discount * 100, ...(receivedPaise > 0 ? { paymentMethod: method as "Cash" | "Card" | "UPI" } : {}),
      };
       const displayOrder: Order = { id: `OFFLINE-${clientMutationId.slice(0, 6).toUpperCase()}`, items: cart, type: orderType, table: orderType === "Dine in" ? table : "—", total, status: "Pending sync", time: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }), payment: received === 0 ? "Pending" : received < total ? "Partial" : method, paidAmount: received, customer: buyerDetails.name || "Walk-in", syncState: "queued", provisionalEstimate: { createdAt: new Date().toISOString(), subtotalPaise: totals.subtotalPaise, discountPaise: totals.discountPaise, serviceChargePaise: totals.serviceChargePaise, taxPaise: totals.taxPaise, totalPaise: totals.totalPaise, paidPaise: receivedPaise, ...(receivedPaise > 0 ? { paymentMethod: method } : {}) } };
      try {
        if (!navigator.onLine) throw new TypeError("offline");
        const result = await readJson<{ order: Record<string, unknown>; bill?: Record<string, unknown>; kot?: Record<string, unknown> }>("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        const createdOrder = mapCloudOrder({
          ...result.order,
          ...(result.kot?.tableLabel ? { table: { label: result.kot.tableLabel } } : {}),
          ...(result.bill ? { bill: result.bill } : {}),
        });
        setData((current) => ({ ...current, orders: [createdOrder, ...current.orders.filter((order) => order.serverId !== createdOrder.serverId)] }));
        void refreshCloudOrders(selectedOutletId).catch(() => setCloudError(cloudOrdersRefreshError));
        notify("Order saved to KORA cloud and kitchen ticket created");
      } catch (error) {
        if (!(error instanceof TypeError) && navigator.onLine) { notify(error instanceof Error ? error.message : "Order could not be saved."); setCloudSaving(false); return; }
        try {
          await queueOrder({ outletId: selectedOutletId, clientMutationId, payload, displayOrder, createdAt: Date.now() });
          setData((current) => ({ ...current, orders: [displayOrder, ...current.orders] }));
          setPendingCount((count) => count + 1);
          notify(`${displayOrder.id} saved offline · will sync when connection returns`);
        } catch {
          notify("Offline order was not saved. Keep this screen open and retry; device storage is unavailable.");
          setCloudSaving(false); return;
        }
      } finally { setCloudSaving(false); }
       setCart([]); setDiscount(0); setPaymentValue(""); setSelectedCustomerId(""); setBuyerDetails({ name: "", gstin: "", address: { line1: "", line2: "", city: "", state: "", pincode: "" } }); setShowBuyerDetails(false); setModal(""); setPage("Orders");
      return;
    }
    const nextOrderNumber = Math.max(1048, ...data.orders.map((o) => Number(o.id.replace(/\D/g, "")) || 0)) + 1;
     const order: Order = { id: `K-${nextOrderNumber}`, items: cart, type: orderType, table: orderType === "Dine in" ? table : "—", total, status: "Preparing", time: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }), payment: received === 0 ? "Pending" : received < total ? "Partial" : method, paidAmount: received, customer: buyerDetails.name || "Walk-in" };
    const nextData = { ...data, orders: [order, ...data.orders] };
    try { localStorage.setItem("kora-demo-v1", JSON.stringify(nextData)); }
    catch { notify("Order was not saved. Free device storage and retry."); return; }
     setData(nextData); setCart([]); setDiscount(0); setPaymentValue(""); setSelectedCustomerId(""); setBuyerDetails({ name: "", gstin: "", address: { line1: "", line2: "", city: "", state: "", pincode: "" } }); setShowBuyerDetails(false); setModal(""); setPage("Orders");
    notify(`${order.id} saved on this device${online ? " · demo mode" : " · working offline"}`);
  };

  const connectCloud = async () => {
    if (cart.length) { setCloudError("Clear the local demo cart before connecting a restaurant account."); return; }
    setCloudError(""); setCloudLoading(true);
    try {
      const session = await signIn(loginInput);
      if (!session.outlets.length) throw new Error("This account has no assigned outlets.");
      demoSnapshot.current = latestData.current;
      setCloudSession(session); setSelectedOutletId(session.outlets[0].id); setOfflineOnly(false); setModal("");
      void saveOfflineWorkspace({ userId: session.user.id, userName: session.user.name, outletId: session.outlets[0].id, outletName: session.outlets[0].name, role: session.outlets[0].role, permissions: session.outlets[0].permissions }).catch(() => undefined);
      setLoginInput((value) => ({ ...value, password: "" }));
      notify(`Connected to ${session.outlets[0].name}`);
    } catch (error) { setCloudError(error instanceof Error ? error.message : "Sign-in failed."); }
    finally { setCloudLoading(false); }
  };
  const createRestaurantAccount = async () => {
    if (cart.length) { setCloudError("Clear the local demo cart before creating a restaurant account."); return; }
    setCloudError(""); setCloudLoading(true);
    try {
      const session = await registerRestaurant(registerInput);
      if (!session.outlets.length) throw new Error("Restaurant account was created without an outlet assignment.");
      demoSnapshot.current = latestData.current;
      setCloudSession(session); setSelectedOutletId(session.outlets[0].id); setOfflineOnly(false); setPage("POS"); setModal("");
      void saveOfflineWorkspace({ userId: session.user.id, userName: session.user.name, outletId: session.outlets[0].id, outletName: session.outlets[0].name, role: session.outlets[0].role, permissions: session.outlets[0].permissions }).catch(() => undefined);
      setRegisterInput((value) => ({ ...value, password: "" }));
      notify(`Restaurant ready · ${session.outlets[0].name}`);
    } catch (error) { setCloudError(error instanceof Error ? error.message : "Restaurant setup failed."); }
    finally { setCloudLoading(false); }
  };
  const disconnectCloud = async () => {
    await signOut();
    setCloudSession(null); setSelectedOutletId(""); setCloudTables([]); setPendingCount(0); setCart([]); setOfflineOnly(false); setOfflinePermissionExpiresAt(null);
    await clearOfflineWorkspace().catch(() => undefined);
    setData(demoSnapshot.current ?? seed); demoSnapshot.current = null; setModal("");
    notify("Signed out of the restaurant account");
  };
  const outletCreated = async (outletId: string) => {
    const session = await readSession();
    const outlet = session.outlets.find((item) => item.id === outletId);
    if (!outlet) throw new Error("Outlet was created, but your new access could not be loaded. Refresh your session.");
    setCloudSession(session);
    setSelectedOutletId(outlet.id);
    setModal("");
    await loadCloudOutlet(outlet.id, outlet.permissions);
    void saveOfflineWorkspace({ userId: session.user.id, userName: session.user.name, outletId: outlet.id, outletName: outlet.name, role: outlet.role, permissions: outlet.permissions }).catch(() => undefined);
    notify(`${outlet.name} is ready. Inventory starts empty.`);
  };
  const changeOrderStatus = async (order: Order, status: string) => {
    if (!cloudMode) {
      setData((current) => ({ ...current, orders: current.orders.map((item) => item.id === order.id ? { ...item, status } : item) }));
      notify(`${order.id} marked ${status.toLowerCase()}`); return;
    }
    if (!order.serverId) { notify("This offline order must sync before its kitchen status can change."); return; }
    try {
      const action = status === "Ready" ? "kot-ready" : "kot-served";
      await readJson(`/api/orders/${encodeURIComponent(order.serverId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId: selectedOutletId, action }) });
      await refreshCloudOrders(selectedOutletId); notify(`${order.id} marked ${status.toLowerCase()}`);
    } catch (error) { notify(error instanceof Error ? error.message : "Kitchen status could not be updated."); }
  };
  const transferCloudOrder = async (order: Order, targetLabel: string) => {
    if (!cloudMode) {
      setData((current) => ({ ...current, orders: current.orders.map((item) => item.id === order.id ? { ...item, table: targetLabel } : item) }));
      notify(`${order.id} moved to ${targetLabel}`); return;
    }
    const target = cloudTables.find((item) => item.label === targetLabel);
    if (!order.serverId || !target) { notify("Choose an active table before transferring this order."); return; }
    try {
      await readJson(`/api/orders/${encodeURIComponent(order.serverId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId: selectedOutletId, action: "transfer-table", tableId: target.id }) });
      await refreshCloudOrders(selectedOutletId); notify(`${order.id} moved to ${targetLabel}`);
    } catch (error) { notify(error instanceof Error ? error.message : "Table transfer failed."); }
  };
  const recordOrderPayment = async (order: Order, amountPaise: number, method: "Cash" | "Card" | "UPI", clientMutationId: string) => {
    if (!cloudMode) {
      const amount = amountPaise / 100;
      const alreadyPaid = order.paidAmount ?? (order.payment === "Pending" ? 0 : order.total);
      const paidAmount = alreadyPaid + amount;
      setData((current) => ({ ...current, orders: current.orders.map((item) => item.id === order.id ? { ...item, paidAmount, payment: paidAmount >= item.total ? method : "Partial" } : item) }));
      notify(`${fmt(amount)} payment recorded for ${order.id}`); return;
    }
    if (!order.serverId) throw new Error("This offline order must sync before another payment can be recorded.");
    if (!navigator.onLine) throw new Error("Payment recording needs a live connection. No payment was recorded.");
    await readJson(`/api/orders/${encodeURIComponent(order.serverId)}/payments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId: selectedOutletId, deviceId: getDeviceId(), clientMutationId, amountPaise, method }) });
    await refreshCloudOrders(selectedOutletId);
    notify(`${fmt(amountPaise / 100)} payment recorded for ${order.id}`);
  };
  const refundOrderPayment = async (order: Order, paymentId: string, amountPaise: number, reason: string, clientMutationId: string) => {
    if (!cloudMode || !navigator.onLine || !order.serverId) throw new Error("Refunds need a connected cloud order. No refund was recorded.");
    await readJson(`/api/orders/${encodeURIComponent(order.serverId)}/payments/${encodeURIComponent(paymentId)}/refunds`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ outletId: selectedOutletId, deviceId: getDeviceId(), clientMutationId, amountPaise, reason }),
    });
    await refreshCloudOrders(selectedOutletId);
    notify("Refund recorded in KORA. Complete the transfer through the original payment provider.");
  };
  const appendOrderItems = async (order: Order, items: Array<{ menuItemId: string; quantity: number }>) => {
    if (!cloudMode || !navigator.onLine || !order.serverId) throw new Error("Adding items needs a live connection to an active cloud order.");
    await readJson(`/api/orders/${encodeURIComponent(order.serverId)}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId: selectedOutletId, clientMutationId: crypto.randomUUID(), items }) });
    await loadCloudOutlet(selectedOutletId, currentOutlet?.permissions ?? []);
  };
  const updateAvailability = async (product: Product) => {
    if (!cloudMode) { setData((current) => ({ ...current, products: current.products.map((item) => item.id === product.id ? { ...item, available: !item.available } : item) })); return; }
    try {
      await readJson("/api/menu", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId: selectedOutletId, menuItemId: product.id, available: !product.available }) });
      setData((current) => ({ ...current, products: current.products.map((item) => item.id === product.id ? { ...item, available: !item.available } : item) }));
      notify(`${product.name} ${product.available ? "marked unavailable" : "marked available"}`);
    } catch (error) { notify(error instanceof Error ? error.message : "Menu availability could not be updated."); }
  };
  const updateTaxClassification = async (product: Product, taxCodeKind: "HSN" | "SAC" | null, taxCode: string | null) => {
    if (!cloudMode) { notify("Connect a restaurant account to save tax classifications."); return; }
    try {
      await readJson("/api/menu", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId: selectedOutletId, menuItemId: product.id, taxCodeKind, taxCode }) });
      setData((current) => ({ ...current, products: current.products.map((item) => item.id === product.id ? { ...item, taxCodeKind, taxCode } : item) }));
      notify(`${product.name} HSN/SAC saved and audited`);
    } catch (error) { throw error; }
  };
  const openInvoicePreview = async (order: Order) => {
    if (!cloudMode || !order.invoiceBillId) { notify("This local/demo order has no issued cloud bill document."); return; }
    try {
      const document = await readJson<InvoicePrintData>(`/api/bills/${encodeURIComponent(order.invoiceBillId)}/invoice?outletId=${encodeURIComponent(selectedOutletId)}`);
      setInvoiceDocument(document);
    } catch (error) { notify(error instanceof Error ? error.message : "Invoice could not be prepared for printing."); }
  };
  const createMenuItem = async () => {
    const pricePaise = Math.round(Number(newItem.price) * 100);
    if (!newItem.name.trim() || !Number.isSafeInteger(pricePaise) || pricePaise <= 0) return;
    if (!cloudMode) {
      setData((current) => ({ ...current, products: [{ id: crypto.randomUUID(), name: newItem.name.trim(), category: newItem.category, price: pricePaise / 100, color: "sage", emoji: "🍽️", available: true }, ...current.products] }));
    } else {
      const categoryId = data.products.find((product) => product.category === newItem.category)?.categoryId;
      if (!categoryId) { notify("This category is not available for menu changes."); return; }
      try {
        await readJson("/api/menu", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId: selectedOutletId, categoryId, name: newItem.name.trim(), pricePaise }) });
        await loadCloudOutlet(selectedOutletId, currentOutlet?.permissions ?? []);
      } catch (error) { notify(error instanceof Error ? error.message : "Menu item could not be created."); return; }
    }
    setModal(""); setNewItem({ name: "", category: "Mains", price: "" }); notify("Dish added to your menu");
  };
  const createCustomer = async () => {
    if (!newCustomer.name.trim() || !newCustomer.phone.trim()) return;
    if (!cloudMode) setData((current) => ({ ...current, customers: [{ ...newCustomer, visits: 0, spend: 0 }, ...current.customers] }));
    else {
      try {
        const saved = await readJson<{ id: string; name: string | null; phone: string }>("/api/customers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId: selectedOutletId, ...newCustomer }) });
        setData((current) => ({ ...current, customers: [{ id: saved.id, name: saved.name ?? newCustomer.name, phone: saved.phone, visits: 0, spend: 0 }, ...current.customers.filter((customer) => customer.id !== saved.id)] }));
        setSelectedCustomerId(saved.id);
      } catch (error) { notify(error instanceof Error ? error.message : "Customer profile could not be saved."); return; }
    }
    setNewCustomer({ name: "", phone: "" }); setModal(""); notify("Customer profile created");
  };
  const openCashierShift = async () => {
    let paise: number;
    try { paise = parseRupeesToPaise(openingCash); } catch { notify("Enter a valid opening float with no more than two decimal places"); return; }
    if (cloudMode) {
      try {
        await readJson("/api/shifts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId: selectedOutletId, action: "open", openingCashPaise: paise }) });
      } catch (error) { notify(error instanceof Error ? error.message : "Shift could not be opened."); return; }
    }
    setData((current) => ({ ...current, shiftOpen: true, cashOpen: paise / 100 })); setModal(""); notify(`Shift opened · opening float ${fmt(paise / 100)}${cloudMode ? " · cloud" : " · local demo"}`);
  };
  const closeCashierShift = async () => {
    let countedPaise: number;
    try { countedPaise = parseRupeesToPaise(cashCounted); } catch { notify("Enter a valid cash count with no more than two decimal places"); return; }
    let variancePaise = countedPaise - Math.round(data.cashOpen * 100);
    if (cloudMode) {
      try {
        const result = await readJson<{ reconciliation: { variancePaise: number } }>("/api/shifts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId: selectedOutletId, action: "close", countedCashPaise: countedPaise }) });
        variancePaise = result.reconciliation.variancePaise;
      } catch (error) { notify(error instanceof Error ? error.message : "Shift could not be closed."); return; }
    }
    setData((current) => ({ ...current, shiftOpen: false })); setModal(""); notify(`Shift closed · cash variance ${fmt(variancePaise / 100)}${cloudMode ? " · cloud" : " · local demo"}`);
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setPage("Overview")}><span className="brand-mark">k</span><span className="brand-name">kora<span className="brand-period">.</span><small>RESTAURANT OS</small></span><ChevronDown size={15} className="brand-chevron" /></button>
        <button className="outlet-select" onClick={() => cloudSession ? setModal("outlet") : setModal("connect")}><span className="outlet-icon"><Store size={16} /></span><span className="outlet-copy"><b>{currentOutlet?.name ?? "The Saffron Room"}</b><small>{cloudSession ? `${cloudSession.user.name} · ${currentOutlet?.role ?? "Choose outlet"}` : "Local demo workspace"}</small></span><ChevronDown size={14} /></button>
        {(["Workspace", "Manage", "Insights"] as const).map((group) => <div className="nav-group" key={group}><p className="nav-heading">{group}</p>{navItems.filter((n) => n.group === group && canAccessPage(n.label)).map(({ label, icon: Icon }) => <button key={label} className={`nav-link ${page === label ? "active" : ""}`} onClick={() => label === "Kitchen Display" ? window.location.assign("/kds") : setPage(label)}><Icon size={17} strokeWidth={1.9} /><span>{label}</span>{label === "Orders" && <span className="nav-badge">{data.orders.filter((o)=>["Preparing","Ready"].includes(o.status)).length}</span>}</button>)}</div>)}
        <div className="sidebar-bottom"><div className="plan-card"><span className="plan-icon"><Sparkles size={15} /></span><div><b>{cloudMode ? "Cloud account" : "Free plan"}</b><small>{cloudMode ? currentOutlet?.role : "Explore KORA Plus"}</small></div><ArrowUpRight size={14} /></div><button className="profile-row" onClick={() => cloudMode ? void disconnectCloud() : setModal("connect")}><span className="avatar avatar-moss">{initials(cloudSession?.user.name ?? "Arjun Sharma")}</span><span className="profile-copy"><b>{cloudSession?.user.name ?? "Arjun Sharma"}</b><small>{cloudMode ? "Sign out" : "Connect restaurant"}</small></span><LogOut size={17} /></button></div>
      </aside>

      <section className="main-area">
        <header className="topbar"><div className="crumbs"><span>Workspace</span><ChevronRight size={13} /><strong>{page === "POS" ? "Point of sale" : page}</strong></div><div className="topbar-actions">{effectivePermissions.includes("shift.open") && <button className={`shift-pill ${data.shiftOpen ? "shift-open" : "shift-closed"}`} onClick={() => { if (data.shiftOpen) { setCashCounted(""); setModal("shift"); } else { setOpeningCash(""); setModal("openShift"); } }}><Clock3 size={13}/>{data.shiftOpen ? "Shift open" : "Open shift"}</button>}<span className={`sync-pill ${online ? "online" : "offline"}`}>{online ? <Wifi size={13} /> : <WifiOff size={13} />}{syncLabel}</span>{cloudMode ? <button className="secondary-button" onClick={() => setModal("outlet")}>{currentOutlet?.name ?? "Outlet"}</button> : <label className="demo-role-switch"><span className="sr-only">Demo role</span><select aria-label="Demo role" value={demoRole} onChange={(event) => setDemoRole(event.target.value as keyof typeof systemRolePermissions)}>{Object.keys(systemRolePermissions).map((role) => <option key={role} value={role}>{role.replaceAll("_", " ")}</option>)}</select></label>} {cloudMode ? null : <button className="secondary-button" onClick={() => setModal("connect")}>Connect cloud</button>}<button className="icon-button notification-button" aria-label="Notifications" onClick={() => notify("You’re all caught up")}><Bell size={17} /><i /></button><span className="top-divider" /><button className="avatar avatar-small avatar-moss" onClick={() => cloudMode ? void disconnectCloud() : setPage("Settings")}>{initials(cloudSession?.user.name ?? "Arjun Sharma")}</button></div></header>
        <div className="page-content">
          {cloudMode && !online && <div className={`offline-permission-banner ${offlinePermissionExpiresAt === null ? "expired" : ""}`} role="status" aria-live="polite"><WifiOff size={18}/><div><b>{offlinePermissionExpiresAt === null ? "Offline permissions expired" : "Offline work is provisional"}</b><span>{offlinePermissionExpiresAt === null ? "Protected actions are disabled. Reconnect and sign in to refresh outlet access." : `Using the last server-verified outlet permissions until ${new Date(offlinePermissionExpiresAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}. Orders and recorded payments remain provisional; the server rechecks access, prices, stock and shift state on sync.`}</span></div>{pendingCount > 0 && <strong>{pendingCount} queued</strong>}</div>}
          {!canAccessPage(page) ? <div className="empty-state no-access"><ShieldCheck size={25}/><b>You don’t have access to this area</b><span>Ask an owner to assign the required outlet role.</span><button className="secondary-button" onClick={() => setPage("Overview")}>Back to overview</button></div> : <>
          {page === "Overview" && <Overview data={data} todayOrders={todayOrders} todaySales={todaySales} role={cloudMode ? currentOutlet?.role ?? "" : demoRole} canCreateOrders={effectivePermissions.includes("orders.create")} cloudMode={cloudMode} outletName={currentOutlet?.name ?? "Outlet"} pendingCount={pendingCount} cloudLoading={cloudLoading} cloudError={cloudError} canManageTeam={effectivePermissions.includes("staff.manage") || effectivePermissions.includes("roles.manage")} canViewReports={effectivePermissions.includes("reports.view.sales")} onNavigate={setPage} onNotify={notify} />}
          {page === "POS" && <section className="pos-layout"><div className="menu-panel"><div className="page-title-row"><div><p className="eyebrow">POINT OF SALE</p><h1>{cloudMode ? "Welcome, " + (cloudSession?.user.name.split(" ")[0] ?? "") : "Good afternoon, Arjun"} <span className="wave">✳</span></h1><p className="muted">{cloudMode ? (currentOutlet?.name ?? "Cloud outlet") + " · " + (online ? "Cloud data" : "Offline menu cache") : "Tuesday, 24 November · Lunch service is in full swing."}</p></div><button className="secondary-button" onClick={() => cloudMode ? void loadCloudOutlet(selectedOutletId, currentOutlet?.permissions ?? []) : notify("Menu is up to date")}><Clock3 size={15} /> {cloudLoading ? "Syncing…" : "Refresh menu"}</button></div><div className="pos-toolbar"><div className="search-box"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search dishes..." /><kbd>⌘ K</kbd></div><button className="filter-button" onClick={() => setCategory("All items")}><SlidersHorizontal size={15} /> Filter</button></div><div className="category-row">{categories.map((c) => <button key={c} className={`category-chip ${category === c ? "selected" : ""}`} onClick={() => setCategory(c)}>{c}</button>)}</div><div className="product-grid">{visibleProducts.map((p) => <button key={p.id} className="product-card" onClick={() => addToCart(p)}><span className={`product-art ${p.color}`}><span>{p.emoji}</span><i>＋</i></span><span className="product-info"><b>{p.name}</b><small>{p.category}</small><strong>{fmt(p.price)}</strong></span></button>)}{visibleProducts.length === 0 && <div className="empty-state"><Search size={25} /><b>{cloudLoading ? "Loading outlet menu" : "No dishes found"}</b><span>{cloudError || "Try another search or category."}</span></div>}</div><div className="menu-footer"><span><span className="green-dot" /> {cloudMode ? "Outlet menu · cached for offline use" : "Menu saved on this device"}</span><button onClick={() => setPage("Menu")}>Manage menu <ArrowRight size={14} /></button></div></div>
            <div className="cart-panel"><div className="cart-header"><div><p className="eyebrow">CURRENT ORDER</p><h2>New order <span className="order-dot">●</span></h2></div><button className="icon-button" aria-label="Clear order" onClick={() => { setCart([]); setDiscount(0); }}><Ellipsis size={18} /></button></div><div className="order-toggle">{["Dine in", "Takeaway", "Delivery"].map((t) => <button key={t} className={orderType === t ? "chosen" : ""} onClick={() => setOrderType(t)}>{t}</button>)}</div>{orderType === "Dine in" && <div className="table-line"><span>Table</span><div className="table-selects">{(cloudMode ? cloudTables : ["T-04", "T-05", "T-06", "T-08"].map((label) => ({ id: label, label, capacity: 2, occupied: false }))).map((t) => <button key={t.id} disabled={cloudMode && t.occupied} className={(table === t.label ? "selected" : "") + (t.occupied ? " unavailable" : "")} onClick={() => setTable(t.label)}>{t.label}</button>)}</div><button aria-label="More tables" className="table-more" onClick={() => notify(cloudMode ? String(cloudTables.length) + " outlet tables loaded" : "Showing available tables")}>···</button></div>}{cloudMode && currentOutlet?.permissions.includes("customers.view") && <div className="table-line"><span>Guest</span><select aria-label="Link customer to order" value={selectedCustomerId} onChange={(e) => setSelectedCustomerId(e.target.value)}><option value="">Walk-in guest</option>{data.customers.filter((customer) => customer.id).map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · {customer.phone}</option>)}</select></div>}<div className="cart-items">{cart.length ? cart.map((item) => <div className="cart-item" key={item.id}><div className="cart-item-icon">{data.products.find((p) => p.id === item.productId)?.emoji ?? "🍽️"}</div><div className="cart-item-name"><b>{item.name}</b>{canSettleBills && <small>{fmt(item.price)} / item</small>}</div><div className="qty-control"><button aria-label={`Remove one ${item.name}`} onClick={() => changeQty(item.id, -1)}><Minus size={12} /></button><b>{item.qty}</b><button aria-label={`Add one ${item.name}`} onClick={() => changeQty(item.id, 1)}><Plus size={12} /></button></div>{canSettleBills && <strong className="line-total">{fmt(item.price * item.qty)}</strong>}</div>) : <div className="cart-empty"><span className="cart-empty-icon"><ShoppingBag size={20} /></span><b>Your order is empty</b><small>Add dishes from the menu to get started.</small></div>}</div><button className="add-note" onClick={() => notify("Add notes to a dish from the order details")}>＋ <span>Add a note or cooking request</span></button><div className="bill-summary" hidden={!canSettleBills}><div><span>Subtotal <small>({cartQty} items)</small></span><b>{fmt(subtotal)}</b></div><div><span>GST <small>per menu item</small></span><b>{fmt(tax)}</b></div>{totals.serviceChargePaise>0&&<div><span>Service charge</span><b>{fmt(totals.serviceChargePaise/100)}</b></div>}<div><button className="discount-link" disabled={!effectivePermissions.includes("bills.discount.apply")} onClick={() => setDiscount(discount ? 0 : 10)}><Tag size={13} />{discount ? `Discount (${discount}%) · remove` : "Add discount / coupon"}</button><b>{discountAmount ? `−${fmt(discountAmount)}` : "—"}</b></div></div><div className="total-row" hidden={!canSettleBills}><span>Total due</span><b>{fmt(total)}</b></div><button className="pay-button" disabled={!cart.length || cloudSaving || (cloudMode && orderType === "Dine in" && !cloudTables.some((item) => item.label === table && !item.occupied))} onClick={() => canSettleBills ? setModal("payment") : void placeOrder("Pending")}><span>{canSettleBills ? `Charge ${fmt(total)}` : "Send order to kitchen"}</span><span className="pay-button-right">{canSettleBills ? "Pay now" : "Send order"} <ArrowRight size={15} /></span></button><div className="cart-footnote"><ShieldCheck size={13} /> {canSettleBills ? "Secure billing · document follows the outlet tax profile" : "Order goes to kitchen · payment remains pending"}</div></div></section>}
          {page === "Orders" && <OrdersPage orders={data.orders} products={data.products} setData={setData} onNotify={notify} onNavigate={setPage} onStatusChange={changeOrderStatus} onTransfer={transferCloudOrder} onRecordPayment={recordOrderPayment} onRefundPayment={refundOrderPayment} onAddItems={appendOrderItems} onRetrySync={retryPendingOrder} onPrintBill={openInvoicePreview} onPrintOffline={(order, mode) => setOfflinePrint({ order, mode })} tables={cloudTables} cloudMode={cloudMode} showFinancials={canSettleBills || effectivePermissions.includes("reports.view.financial")} canSettleBills={canSettleBills} canPrintKot={effectivePermissions.includes("kot.print")} canRefund={canRefundBills} canCreateOrders={effectivePermissions.includes("orders.create")} canMoveTable={effectivePermissions.includes("orders.move_table")} canBump={effectivePermissions.includes("kds.bump")} canEditOrders={effectivePermissions.includes("orders.edit") && effectivePermissions.includes("kot.print")} />}
          {page === "Kitchen" && <KitchenPage orders={data.orders} setData={setData} onNotify={notify} onStatusChange={changeOrderStatus} />}
          {page === "Menu" && <MenuPage data={data} setData={setData} onAdd={() => setModal("additem")} onNotify={notify} onAvailabilityChange={updateAvailability} onTaxCodeChange={updateTaxClassification} cloudMode={cloudMode} canEditMenu={canEditMenu} canEditTax={canEditTax} />}
          {page === "Inventory" && (cloudMode ? <CloudInventoryPage outletId={selectedOutletId} canAdjustStock={effectivePermissions.includes("inventory.adjust")} /> : <InventoryPage products={data.products} onNotify={notify} />)}
          {page === "Customers" && (cloudMode ? <CloudCustomersPage customers={data.customers} onAdd={() => setModal("customer")} /> : <CustomersPage customers={data.customers} onAdd={() => setModal("customer")} canManage={canManageCustomers} />)}
          {page === "Team" && <RoleAdministration outletId={selectedOutletId} permissions={effectivePermissions} onNotify={notify} />}
          {page === "Reports" && (cloudMode ? <CloudReportsPage outletId={selectedOutletId} canViewFinancials={effectivePermissions.includes("reports.view.financial")} canViewGst={effectivePermissions.includes("reports.view.gst")} /> : <ReportsPage range={range} setRange={setRange} todaySales={todaySales} onNotify={notify} />)}
          {page === "Audit" && <AuditLogViewer outletId={selectedOutletId} onNotify={notify} />}
          {page === "Settings" && <>{cloudMode ? <OutletProfileSettings key={selectedOutletId} outletId={selectedOutletId} permissions={effectivePermissions} onNotify={notify} /> : <SettingsPage data={data} setData={setData} onNotify={notify} />}<OutletApprovalSettings outletId={selectedOutletId} permissions={effectivePermissions} cloudMode={cloudMode} demoRole={demoRole} setDemoRole={setDemoRole} onNotify={notify} /></>}
          </>}
        </div>
      </section>
      {notice && <div className="toast"><CheckCircle2 size={17} />{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} /></button></div>}
      {invoiceDocument && <InvoicePrintDocument document={invoiceDocument} onClose={() => setInvoiceDocument(null)} />}
      {offlinePrint && <OfflinePrintDocument order={offlinePrint.order} outletName={currentOutlet?.name ?? "Restaurant outlet"} mode={offlinePrint.mode} onClose={() => setOfflinePrint(null)} />}
      {modal === "payment" && canSettleBills && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(""); }}><div className="modal payment-modal"><button className="modal-close" onClick={() => setModal("")}><X size={18} /></button><span className="modal-icon"><Wallet size={20} /></span><p className="eyebrow">COMPLETE ORDER</p><h2>Choose payment</h2><p className="muted">Record full, partial, or pending payment for this bill.</p><div className="payment-total"><span>Amount due</span><b>{fmt(total)}</b></div><BuyerInvoiceDetailsForm details={buyerDetails} setDetails={setBuyerDetails} open={showBuyerDetails} setOpen={setShowBuyerDetails} /><div className="payment-options">{[{ n: "UPI", e: "◉", d: "QR or UPI app" }, { n: "Cash", e: "₹", d: "Cash at counter" }, { n: "Card", e: "▣", d: "Credit or debit" }, { n: "Pending", e: "◷", d: "Pay later" }].map(({ n, e, d }) => <button key={n} className={paymentMethod === n ? "selected" : ""} onClick={() => setPaymentMethod(n)}><span className="method-icon">{e}</span><span><b>{n}</b><small>{d}</small></span>{paymentMethod === n && <Check size={16} />}</button>)}</div>{paymentMethod !== "Pending" && <label className="payment-amount">Amount received (₹)<input type="text" inputMode="decimal" min="0" max={total} value={paymentValue} onChange={(e) => setPaymentValue(e.target.value)} placeholder={`${fmt(total)} · full amount`} /></label>}<button className="primary-button full-button" onClick={() => placeOrder(paymentMethod)} disabled={!cart.length || cloudSaving || (parsedPaymentPaise !== null && (!Number.isSafeInteger(parsedPaymentPaise) || parsedPaymentPaise < 0 || parsedPaymentPaise > totals.totalPaise))}>Confirm {paymentMethod === "Pending" || parsedPaymentPaise === 0 ? "order" : parsedPaymentPaise !== null && parsedPaymentPaise < totals.totalPaise ? "partial payment" : "payment"} · {fmt((paymentMethod === "Pending" ? 0 : parsedPaymentPaise ?? totals.totalPaise) / 100)} <ArrowRight size={16} /></button><div className="secure-note"><ShieldCheck size={14} /> {cloudMode ? (online ? "Saved to KORA cloud · kitchen ticket included" : "Queued securely on this device for sync") : "Saved on this device · demo mode"}</div></div></div>}
      {modal === "additem" && canEditMenu && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(""); }}><form className="modal form-modal" onSubmit={(e) => { e.preventDefault(); void createMenuItem(); }}><button type="button" className="modal-close" onClick={() => setModal("")}><X size={18} /></button><p className="eyebrow">MENU MANAGEMENT</p><h2>Add a dish</h2><label>Dish name<input required autoFocus value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} placeholder="e.g. Tandoori Roti" /></label><div className="form-split"><label>Category<select value={newItem.category} onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}>{categories.slice(1).map((c) => <option key={c}>{c}</option>)}{!cloudMode && <option>New category</option>}</select></label><label>Price (₹)<input required type="number" min="1" step="1" value={newItem.price} onChange={(e) => setNewItem({ ...newItem, price: e.target.value })} placeholder="0" /></label></div><button className="primary-button full-button" type="submit">Add to menu <ArrowRight size={15} /></button></form></div>}
      {modal === "customer" && canManageCustomers && <div className="modal-backdrop"><form className="modal form-modal" onSubmit={(e) => { e.preventDefault(); void createCustomer(); }}><button type="button" className="modal-close" onClick={() => setModal("")}><X size={18} /></button><p className="eyebrow">CUSTOMER CRM</p><h2>Add a customer</h2><label>Full name<input required value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} placeholder="Customer name" /></label><label>Mobile number<input required type="tel" pattern="[+0-9() -]{8,}" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} placeholder="+91 98765 43210" /></label><button className="primary-button full-button">Create profile <ArrowRight size={15} /></button></form></div>}
      {modal === "shift" && <div className="modal-backdrop"><form className="modal form-modal" onSubmit={(e) => { e.preventDefault(); void closeCashierShift(); }}><button type="button" className="modal-close" onClick={() => setModal("")}><X size={18}/></button><p className="eyebrow">SHIFT RECONCILIATION</p><h2>Close your shift</h2><p className="muted">{cloudMode ? "Count the cash drawer. KORA reconciles paid cash against this shift." : "Count the cash drawer and compare it with the opening float recorded on this device."}</p><div className="payment-total"><span>Opening cash</span><b>{fmt(data.cashOpen)}</b></div><label>Cash counted (₹)<input required type="text" inputMode="decimal" value={cashCounted} onChange={(e)=>setCashCounted(e.target.value)} placeholder="Enter drawer total"/></label><button className="primary-button full-button" type="submit" disabled={!cashCounted}>Close shift <Check size={15}/></button></form></div>}
      {modal === "openShift" && <div className="modal-backdrop"><form className="modal form-modal" onSubmit={(e) => { e.preventDefault(); void openCashierShift(); }}><button type="button" className="modal-close" onClick={() => setModal("")}><X size={18}/></button><p className="eyebrow">START A CASHIER SHIFT</p><h2>Count opening cash</h2><p className="muted">{cloudMode ? "This opening float is stored in the outlet shift ledger." : "This demo records the opening float on this device only."}</p><label>Opening cash (₹)<input required type="text" inputMode="decimal" value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} placeholder="e.g. 5000.00" /></label><button className="primary-button full-button" type="submit" disabled={!openingCash}>Open shift <ArrowRight size={15}/></button></form></div>}
      {modal === "connect" && <div className="modal-backdrop" role="presentation"><form className="modal form-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" onSubmit={(e) => { e.preventDefault(); authMode === "signin" ? void connectCloud() : void createRestaurantAccount(); }}><button type="button" className="modal-close" onClick={() => { setModal(""); setCloudError(""); setLoginInput((value) => ({ ...value, password: "" })); setRegisterInput((value) => ({ ...value, password: "" })); }} aria-label="Close"><X size={18}/></button><p className="eyebrow">RESTAURANT CLOUD</p>{authMode === "signin" ? <><h2 id="connect-title">Connect to KORA</h2><p className="muted">Sign in to load your outlet menu, shifts, customers, orders, and kitchen tickets.</p><label>Restaurant slug<input required autoCapitalize="none" value={loginInput.tenantSlug} onChange={(e) => setLoginInput({ ...loginInput, tenantSlug: e.target.value })} placeholder="e.g. saffron-room-demo"/></label><label>Email<input required type="email" autoCapitalize="none" value={loginInput.email} onChange={(e) => setLoginInput({ ...loginInput, email: e.target.value })} placeholder="owner@restaurant.in"/></label><label>Password<input required type="password" value={loginInput.password} onChange={(e) => setLoginInput({ ...loginInput, password: e.target.value })}/></label></> : <><h2 id="connect-title">Set up your restaurant</h2><p className="muted">Create an owner account and a starter outlet with an Indian menu.</p><label>Restaurant name<input required minLength={2} value={registerInput.tenantName} onChange={(e) => setRegisterInput({ ...registerInput, tenantName: e.target.value })} placeholder="The Saffron Room"/></label><label>First outlet name<input required minLength={2} value={registerInput.outletName} onChange={(e) => setRegisterInput({ ...registerInput, outletName: e.target.value })} placeholder="Indiranagar"/></label><label>Your name<input required minLength={2} value={registerInput.name} onChange={(e) => setRegisterInput({ ...registerInput, name: e.target.value })} placeholder="Restaurant owner"/></label><label>Email<input required type="email" autoCapitalize="none" value={registerInput.email} onChange={(e) => setRegisterInput({ ...registerInput, email: e.target.value })} placeholder="owner@restaurant.in"/></label><label>Password<input required type="password" minLength={12} value={registerInput.password} onChange={(e) => setRegisterInput({ ...registerInput, password: e.target.value })}/><small>Use 12–72 characters.</small></label></>}{cloudError && <p className="form-error" role="alert">{cloudError}</p>}<button className="primary-button full-button" type="submit" disabled={cloudLoading}>{cloudLoading ? "Connecting…" : authMode === "signin" ? "Sign in securely" : "Create restaurant"} <ArrowRight size={15}/></button><button type="button" className="text-link" onClick={() => { setAuthMode(authMode === "signin" ? "register" : "signin"); setCloudError(""); }}>{authMode === "signin" ? "New to KORA? Create a restaurant" : "Already set up? Sign in"}</button><p className="secure-note"><ShieldCheck size={14}/> Access tokens stay in memory. Refresh session uses an HttpOnly cookie.</p></form></div>}
      {modal === "outlet" && cloudSession && <OutletSwitcherModal
        session={cloudSession}
        selectedOutletId={selectedOutletId}
        cartHasItems={cart.length > 0}
        onSwitch={(outletId) => {
          if (cart.length) { notify("Finish or clear the current cart before switching outlets."); return; }
          setSelectedOutletId(outletId);
          setModal("");
        }}
        onCreated={outletCreated}
        onClose={() => setModal("")}
        onSignOut={() => void disconnectCloud()}
      />}    </main>
  );
}

function OutletSwitcherModal({ session, selectedOutletId, cartHasItems, onSwitch, onCreated, onClose, onSignOut }: {
  session: AuthenticatedSession;
  selectedOutletId: string;
  cartHasItems: boolean;
  onSwitch: (outletId: string) => void;
  onCreated: (outletId: string) => Promise<void>;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selected = session.outlets.find((outlet) => outlet.id === selectedOutletId);
  const canManageOutlets = selected?.permissions.includes("outlets.manage") ?? false;

  const createOutlet = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (cartHasItems) { setError("Finish or clear the current cart before creating and switching outlets."); return; }
    setSaving(true);
    setError("");
    try {
      const result = await readJson<{ outlet: { id: string } }>("/api/outlets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outletId: selectedOutletId, name, code }),
      });
      await onCreated(result.outlet.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Outlet could not be created.");
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal form-modal" role="dialog" aria-modal="true" aria-labelledby="outlet-title">
      <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18}/></button>
      <p className="eyebrow">OWNER WORKSPACE</p>
      <h2 id="outlet-title">Your outlets</h2>
      <p className="muted">Outlets have separate orders, tables, stock, and shifts. New outlets start with a copy of this outlet’s menu and tables.</p>
      <label>Switch outlet<select value={selectedOutletId} onChange={(event) => onSwitch(event.target.value)}>
        {session.outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name} · {outlet.role}</option>)}
      </select></label>
      {canManageOutlets && <form className="outlet-create-form" onSubmit={(event) => void createOutlet(event)}>
        <div className="settings-divider"/>
        <p className="settings-subhead">Add outlet</p>
        <label>Outlet name<input required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Bengaluru Airport"/></label>
        <label>Outlet code <small>Optional; 2–12 letters, numbers, hyphens, or underscores.</small><input maxLength={12} value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="Auto-created from the name"/></label>
        <p className="muted">Menu items, variants, add-ons, prices, and tables are copied. Inventory and recipes must be configured for this outlet.</p>
        {cartHasItems && <p className="form-error" role="status">Finish or clear the current cart before adding an outlet.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button full-button" type="submit" disabled={saving || cartHasItems || name.trim().length < 2}>{saving ? "Creating outlet…" : "Create outlet"}<ArrowRight size={15}/></button>
      </form>}
      {!canManageOutlets && <p className="muted">Only restaurant owners can add outlets.</p>}
      <button type="button" className="secondary-button full-button" onClick={onSignOut}><LogOut size={15}/> Sign out</button>
    </div>
  </div>;
}

function Overview({ data, todayOrders, todaySales, role, canCreateOrders, cloudMode, outletName, pendingCount, cloudLoading, cloudError, canManageTeam, canViewReports, onNavigate, onNotify }: { data: AppData; todayOrders: number; todaySales: number; role: string; canCreateOrders: boolean; cloudMode: boolean; outletName: string; pendingCount: number; cloudLoading: boolean; cloudError: string; canManageTeam: boolean; canViewReports: boolean; onNavigate: (p: Page) => void; onNotify: (s: string) => void }) {
  if (cloudMode) return <CloudOverview outletName={outletName} orders={data.orders} pendingCount={pendingCount} loading={cloudLoading} error={cloudError} canCreateOrders={canCreateOrders} canManageTeam={canManageTeam} canViewReports={canViewReports} onNavigate={onNavigate} />;
  const normalizedRole = role.toUpperCase();
  if (normalizedRole === "CHEF") return <><div className="page-title-row"><div><p className="eyebrow">KITCHEN WORKSPACE</p><h1>Kitchen is ready</h1><p className="muted">Your shift starts with the tickets that need attention.</p></div><button className="primary-button" onClick={() => onNavigate("Kitchen")}><Flame size={16}/> Open kitchen</button></div><div className="stats-grid"><StatCard icon={Flame} label="Active tickets" value={String(data.orders.filter((order) => ["Preparing", "Ready"].includes(order.status)).length)} note="in this workspace" change="Live" good/><StatCard icon={Clock3} label="Queue" value={String(data.orders.filter((order) => order.status === "Preparing").length)} note="being prepared" change="Open KDS" good/></div></>;
  if (normalizedRole === "WAITER") return <><div className="page-title-row"><div><p className="eyebrow">FLOOR WORKSPACE</p><h1>Your active tables</h1><p className="muted">Follow your open orders and send updates to the kitchen.</p></div><button className="primary-button" onClick={() => onNavigate("POS")}><Plus size={16}/> Start order</button></div><div className="card content-card"><h2 className="section-title">Active orders</h2>{data.orders.filter((order) => ["Preparing", "Ready"].includes(order.status)).map((order) => <div className="activity-row" key={order.id}><span><b>{order.table === "—" ? order.id : `Table ${order.table}`}</b><small>{order.id} · {order.time}</small></span><span>{order.items.reduce((sum, item) => sum + item.qty, 0)} items<small>{order.items[0]?.name}</small></span><Status status={order.status}/></div>)}{!data.orders.some((order) => ["Preparing", "Ready"].includes(order.status)) && <div className="empty-state"><ShoppingBag size={23}/><b>No active orders</b><span>New orders will appear here.</span></div>}</div></>;
  if (normalizedRole === "CASHIER") return <><div className="page-title-row"><div><p className="eyebrow">COUNTER WORKSPACE</p><h1>Billing desk</h1><p className="muted">Open orders, shift status, and payments at a glance.</p></div><button className="primary-button" onClick={() => onNavigate("POS")}><Plus size={16}/> New bill</button></div><div className="stats-grid"><StatCard icon={ShoppingBag} label="Open orders" value={String(data.orders.filter((order) => !["Completed", "Cancelled"].includes(order.status)).length)} note="awaiting service or payment" change="In service" good/><StatCard icon={Clock3} label="Shift status" value="Use shift control" note="open or reconcile drawer" change="Top bar" good/></div><button className="secondary-button" onClick={() => onNavigate("Orders")}>Review open bills <ArrowRight size={14}/></button></>;
  if (normalizedRole === "RESTAURANT_MANAGER") return <><div className="page-title-row"><div><p className="eyebrow">OUTLET OPERATIONS</p><h1>Live floor & service</h1><p className="muted">Resolve active orders, open shifts, and team approvals.</p></div><button className="primary-button" onClick={() => onNavigate("Orders")}><Activity size={16}/> View live orders</button></div><div className="stats-grid"><StatCard icon={ShoppingBag} label="Active orders" value={String(data.orders.filter((order) => ["Preparing", "Ready"].includes(order.status)).length)} note="across this outlet" change="Live queue" good/><StatCard icon={Clock3} label="Open shifts" value={data.shiftOpen ? "At least 1" : "None shown"} note="cash reconciliation" change="Shift control" good/><StatCard icon={ShieldCheck} label="Approval desk" value="Manager PIN" note="discount & void policy" change="Settings" good/></div><div className="quick-actions"><button onClick={() => onNavigate("Kitchen")}><Flame size={16}/><span><b>Kitchen queue</b><small>Monitor service progress</small></span><ArrowRight size={15}/></button><button onClick={() => onNavigate("Team")}><Users size={16}/><span><b>Team permissions</b><small>Review outlet access</small></span><ArrowRight size={15}/></button><button onClick={() => onNavigate("Inventory")}><Package size={16}/><span><b>Inventory</b><small>Check stock alerts</small></span><ArrowRight size={15}/></button></div></>;
  if (normalizedRole === "ACCOUNTANT") return <><div className="page-title-row"><div><p className="eyebrow">FINANCE WORKSPACE</p><h1>Reports & controls</h1><p className="muted">Review sales, tax, and sensitive outlet actions.</p></div><button className="primary-button" onClick={() => onNavigate("Reports")}><BarChart3 size={16}/> Open reports</button></div><div className="quick-actions"><button onClick={() => onNavigate("Reports")}><FileDown size={16}/><span><b>Sales & GST reports</b><small>Read-only financial views</small></span><ArrowRight size={15}/></button><button onClick={() => onNavigate("Audit")}><ShieldCheck size={16}/><span><b>Audit history</b><small>Discounts, voids, and changes</small></span><ArrowRight size={15}/></button></div></>;
  if (normalizedRole === "INVENTORY_MANAGER") return <><div className="page-title-row"><div><p className="eyebrow">STOCK WORKSPACE</p><h1>Inventory control</h1><p className="muted">Track availability and record stock adjustments.</p></div><button className="primary-button" onClick={() => onNavigate("Inventory")}><Package size={16}/> Open inventory</button></div><p className="muted">Sales and payment totals are hidden for this role.</p></>;
  return <><div className="page-title-row overview-title"><div><p className="eyebrow">TUESDAY, 24 NOVEMBER 2026 <span className="live-tag"><i /> LIVE</span></p><h1>Your restaurant, at a glance<span className="title-period">.</span></h1><p className="muted">Here’s what’s happening at The Saffron Room today.</p></div>{canCreateOrders ? <button className="primary-button" onClick={() => onNavigate("POS")}><Plus size={16} /> New order</button> : <button className="secondary-button" onClick={() => onNavigate("Team")}><Users size={16} /> Manage team</button>}</div><div className="stats-grid"><StatCard icon={BadgeIndianRupee} label="Gross sales" value={fmt(todaySales)} note="vs. yesterday" change="↑ 12.8%" good /><StatCard icon={ShoppingBag} label="Orders today" value={String(todayOrders)} note="vs. yesterday" change="↑ 8.2%" good /><StatCard icon={IndianRupee} label="Avg. order value" value={fmt(Math.round(todaySales / todayOrders))} note="vs. last 7 days" change="↑ 4.1%" good /><StatCard icon={Clock3} label="Avg. prep time" value="14 min" note="vs. last 7 days" change="↓ 2 min" good /></div><div className="dashboard-grid"><section className="card sales-card"><div className="card-heading"><div><h2>Sales overview</h2><p>Revenue performance through the day</p></div><select defaultValue="Today"><option>Today</option><option>This week</option><option>This month</option></select></div><div className="chart-legend"><span><i className="legend-primary" /> Today</span><span><i className="legend-secondary" /> Yesterday</span></div><div className="sales-chart"><div className="y-axis"><span>₹30k</span><span>₹20k</span><span>₹10k</span><span>₹0</span></div><div className="chart-canvas"><div className="grid-lines"><i /><i /><i /><i /></div><svg viewBox="0 0 740 215" preserveAspectRatio="none" role="img" aria-label="Hourly revenue chart"><defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#d9ec79" stopOpacity=".32"/><stop offset="100%" stopColor="#d9ec79" stopOpacity="0"/></linearGradient></defs><path d="M0 184 C45 178 51 164 92 166 S144 143 184 151 S228 116 277 126 S319 110 369 116 S415 76 461 87 S506 64 553 72 S599 47 646 52 S696 24 740 32 L740 215 L0 215Z" fill="url(#area)"/><path d="M0 184 C45 178 51 164 92 166 S144 143 184 151 S228 116 277 126 S319 110 369 116 S415 76 461 87 S506 64 553 72 S599 47 646 52 S696 24 740 32" fill="none" stroke="#7b8d4d" strokeWidth="3" strokeLinecap="round"/><path d="M0 197 C45 189 51 192 92 179 S144 175 184 169 S228 168 277 150 S319 156 369 145 S415 131 461 135 S506 117 553 121 S599 105 646 109 S696 93 740 94" fill="none" stroke="#d3d3c8" strokeWidth="2.5" strokeDasharray="5 7" strokeLinecap="round"/></svg><div className="x-axis"><span>8 AM</span><span>10 AM</span><span>12 PM</span><span>2 PM</span><span>4 PM</span><span>6 PM</span><span>8 PM</span></div></div></div><div className="chart-callout"><span className="callout-dot" /> Peak hour <b>1:00 – 2:00 PM</b><span className="callout-divider" /> Revenue <b>₹6,420</b></div></section><section className="card channel-card"><div className="card-heading"><div><h2>Order channels</h2><p>Where your orders are coming from</p></div><button className="icon-button" onClick={() => onNavigate("Reports")}><ArrowUpRight size={16} /></button></div><div className="donut-wrap"><div className="donut"><div className="donut-center"><b>46</b><small>orders</small></div></div><div className="channel-list"><Channel name="Dine in" pct="52%" amount="24 orders" color="moss"/><Channel name="Takeaway" pct="28%" amount="13 orders" color="lime"/><Channel name="Delivery" pct="20%" amount="9 orders" color="sand"/></div></div><div className="channel-foot"><span>Net sales</span><b>{fmt(todaySales)}</b><span className="trend-small">↑ 12.8%</span></div></section></div><div className="lower-grid"><section className="card activity-card"><div className="card-heading"><div><h2>Live order activity</h2><p>Orders being prepared right now <span className="live-dot" /></p></div><button className="text-link" onClick={() => onNavigate("Orders")}>View all <ArrowRight size={14} /></button></div><div className="activity-table"><div className="table-head"><span>ORDER</span><span>ITEMS</span><span>TYPE</span><span>STATUS</span><span>TOTAL</span></div>{data.orders.slice(0, 4).map((o) => <div className="activity-row" key={o.id}><span><b>{o.id}</b><small>{o.time}</small></span><span>{o.items.reduce((s, i) => s + i.qty, 0)} items <small>{o.items[0]?.name}</small></span><span><i className="table-type-icon">{o.type === "Dine in" ? "▦" : o.type === "Delivery" ? "↗" : "▱"}</i>{o.type}</span><span><Status status={o.status} /></span><b>{fmt(o.total)}</b></div>)}</div><button className="mobile-view-all" onClick={() => onNavigate("Orders")}>View all orders <ArrowRight size={14} /></button></section><section className="card best-sellers"><div className="card-heading"><div><h2>Popular this week</h2><p>Your guest favourites</p></div><button className="icon-button" onClick={() => onNavigate("Reports")}><ArrowUpRight size={16}/></button></div>{[{e:"🥞",n:"Masala Dosa",c:"Breakfast",s:"128 sold",r:"₹23,040"},{e:"🧀",n:"Paneer Tikka",c:"Starters",s:"96 sold",r:"₹26,880"},{e:"🍗",n:"Butter Chicken",c:"Mains",s:"84 sold",r:"₹32,760"},{e:"☕",n:"Filter Coffee",c:"Drinks",s:"72 sold",r:"₹6,480"}].map((x,i)=><div className="seller-row" key={x.n}><span className={`seller-emoji tone-${i}`}>{x.e}</span><span className="seller-name"><b>{x.n}</b><small>{x.c}</small></span><span className="seller-sales"><b>{x.r}</b><small>{x.s}</small></span></div>)}<button className="seller-footer" onClick={() => onNavigate("Reports")}>Explore menu insights <ArrowRight size={14} /></button></section></div><div className="quick-actions"><span className="quick-label">QUICK ACTIONS</span>{canCreateOrders && <button onClick={() => onNavigate("POS")}><span className="quick-icon lime-icon"><Plus size={16}/></span><span><b>New order</b><small>Start a fresh bill</small></span><ArrowRight size={15}/></button>}<button onClick={() => onNavigate("Menu")}><span className="quick-icon peach-icon"><Grid2X2 size={16}/></span><span><b>Update menu</b><small>Prices & availability</small></span><ArrowRight size={15}/></button><button onClick={() => onNavigate("Reports")}><span className="quick-icon lavender-icon"><FileDown size={16}/></span><span><b>Download report</b><small>Daily sales summary</small></span><ArrowRight size={15}/></button><button onClick={() => onNotify("Your team is up to date")}><span className="quick-icon sage-icon"><Users size={16}/></span><span><b>Manage team</b><small>Roles & permissions</small></span><ArrowRight size={15}/></button></div></>;
}
function StatCard({ icon: Icon, label, value, note, change, good }: { icon: typeof House; label: string; value: string; note: string; change: string; good?: boolean }) { return <div className="stat-card"><div className="stat-top"><span className="stat-icon"><Icon size={17}/></span><button className="stat-menu" aria-label={`${label} options`}><MoreHorizontal size={17}/></button></div><p>{label}</p><b className="stat-value">{value}</b><div className="stat-note"><span className={good ? "positive-change" : "negative-change"}>{change}</span><span>{note}</span></div><span className="stat-spark"><svg viewBox="0 0 95 32"><path d="M2 25 C15 24 14 17 24 20 S39 14 48 17 S62 8 72 13 S85 3 94 5" fill="none" stroke="#9eae68" strokeWidth="2" strokeLinecap="round"/></svg></span></div>; }
function Channel({ name, pct, amount, color }: { name: string; pct: string; amount: string; color: string }) { return <div className="channel-row"><span className={`channel-dot ${color}`}/><span>{name}</span><small>{amount}</small><b>{pct}</b></div>; }
function Status({ status }: { status: string }) { const cls = status.toLowerCase().replace(" ", "-"); return <span className={`status-pill ${cls}`}><i/>{status}</span>; }

function OrdersPage({ orders, products, setData, onNotify, onNavigate, onStatusChange, onTransfer, onRecordPayment, onRefundPayment, onAddItems, onRetrySync, onPrintBill, onPrintOffline, tables, cloudMode, showFinancials, canSettleBills, canPrintKot, canRefund, canCreateOrders, canMoveTable, canBump, canEditOrders }: {
  orders: Order[]; products: Product[]; setData: React.Dispatch<React.SetStateAction<AppData>>; onNotify: (s: string) => void; onNavigate: (page: Page) => void;
  onStatusChange: (order: Order, status: string) => Promise<void>; onTransfer: (order: Order, table: string) => Promise<void>;
  onRecordPayment: (order: Order, amountPaise: number, method: "Cash" | "Card" | "UPI", clientMutationId: string) => Promise<void>;
  onRefundPayment: (order: Order, paymentId: string, amountPaise: number, reason: string, clientMutationId: string) => Promise<void>;
  onAddItems: (order: Order, items: Array<{ menuItemId: string; quantity: number }>) => Promise<void>; onRetrySync: (order: Order) => Promise<void>;
  onPrintBill: (order: Order) => Promise<void>;
  onPrintOffline: (order: Order, mode: "receipt" | "kot") => void;
  tables: RestaurantTable[]; cloudMode: boolean; showFinancials: boolean; canSettleBills: boolean; canPrintKot: boolean; canRefund: boolean; canCreateOrders: boolean; canMoveTable: boolean; canBump: boolean; canEditOrders: boolean;
}) {
  const [filter, setFilter] = useState("All orders");
  const [search, setSearch] = useState("");
  const [detailId, setDetailId] = useState("");
  const [transferTable, setTransferTable] = useState("T-05");
  const [recordAmount, setRecordAmount] = useState("");
  const [recordMethod, setRecordMethod] = useState<"Cash" | "Card" | "UPI">("Cash");
  const [refundPaymentId, setRefundPaymentId] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [addItemsOpen, setAddItemsOpen] = useState(false);
  const [addItemQuantities, setAddItemQuantities] = useState<Record<string, number>>({});
  const [savingAddedItems, setSavingAddedItems] = useState(false);
  const paymentMutationIds = useRef<Record<string, string>>({});
  const refundMutationIds = useRef<Record<string, string>>({});
  const detail = orders.find((o) => o.id === detailId);
  const visible = orders.filter((o) => (filter === "All orders" || (filter === "Pending sync" ? Boolean(o.syncState) : o.status === filter)) && `${o.id} ${o.customer} ${o.type}`.toLowerCase().includes(search.toLowerCase()));
  const advance = (order: Order) => {
    if (cloudMode && !order.serverId) { onNotify("This order must sync before its kitchen status can change."); return; }
    const next = order.status === "Preparing" ? "Ready" : order.status === "Ready" ? "Served" : "Completed";
    if (next !== "Completed") void onStatusChange(order, next);
    else { setData((d) => ({ ...d, orders: d.orders.map((o) => o.id === order.id ? { ...o, status: next } : o) })); onNotify(`${order.id} marked completed`); }
  };
  const transfer = () => {
    if (!detail || transferTable === detail.table) return;
    if (cloudMode && !detail.serverId) { onNotify("This order must sync before its table can move."); return; }
    void onTransfer(detail, transferTable);
    setDetailId("");
  };
  const addPayment = () => {
    if (!detail) return;
    if (cloudMode && !detail.serverId) { onNotify("This order must sync before another payment can be recorded."); return; }
    let amountPaise: number;
    try { amountPaise = parseRupeesToPaise(recordAmount); } catch { onNotify("Enter a valid payment with no more than two decimal places"); return; }
    const remainingPaise = Math.max(0, Math.round((detail.total - (detail.paidAmount ?? (detail.payment === "Pending" ? 0 : detail.total))) * 100));
    if (amountPaise <= 0 || amountPaise > remainingPaise) return;
    const mutationId = paymentMutationIds.current[detail.id] ?? (paymentMutationIds.current[detail.id] = crypto.randomUUID());
    void onRecordPayment(detail, amountPaise, recordMethod, mutationId).then(() => {
      delete paymentMutationIds.current[detail.id]; setRecordAmount("");
    }).catch((error) => onNotify(error instanceof Error ? error.message : "Payment could not be recorded."));
  };
  const submitRefund = () => {
    if (!detail || !refundPaymentId || !refundReason.trim()) return;
    const payment = detail.payments?.find((entry) => entry.id === refundPaymentId);
    if (!payment) return;
    let amountPaise: number;
    try { amountPaise = parseRupeesToPaise(refundAmount); } catch { onNotify("Enter a valid refund amount with no more than two decimal places"); return; }
    if (amountPaise <= 0 || amountPaise > payment.refundablePaise || refundReason.trim().length < 3) return;
    const mutationKey = `${detail.id}:${payment.id}:${amountPaise}:${refundReason.trim()}`;
    const mutationId = refundMutationIds.current[mutationKey] ?? (refundMutationIds.current[mutationKey] = crypto.randomUUID());
    void onRefundPayment(detail, payment.id, amountPaise, refundReason.trim(), mutationId).then(() => {
      delete refundMutationIds.current[mutationKey]; setRefundPaymentId(""); setRefundAmount(""); setRefundReason("");
    }).catch((error) => onNotify(error instanceof Error ? error.message : "Refund could not be recorded."));
  };
  const submitAddedItems = async () => {
    if (!detail) return;
    const items = Object.entries(addItemQuantities).filter(([, quantity]) => quantity > 0).map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
    if (!items.length) return;
    setSavingAddedItems(true);
    try {
      await onAddItems(detail, items);
      setAddItemQuantities({}); setAddItemsOpen(false);
      onNotify("New items sent to the kitchen. A follow-up KOT was created.");
    } catch (error) { onNotify(error instanceof Error ? error.message : "New items could not be sent to the kitchen."); }
    finally { setSavingAddedItems(false); }
  };
  return <><div className="page-title-row"><div><p className="eyebrow">SERVICE</p><h1>Orders <span className="count-bubble">{orders.length}</span></h1><p className="muted">Every order, from first ticket to final bill.</p></div>{canCreateOrders && <button className="primary-button" onClick={() => onNavigate("POS")}><Plus size={16}/> New order</button>}</div><div className="card content-card"><div className="table-toolbar"><div className="tabs">{["All orders", "Pending sync", "Preparing", "Ready", "Served"].map((f) => <button className={filter === f ? "active" : ""} key={f} onClick={() => setFilter(f)}>{f}{f === "Pending sync" && <i className="tab-count">{orders.filter((o)=>Boolean(o.syncState)).length}</i>}{f === "Preparing" && <i className="tab-count">{orders.filter((o)=>o.status==="Preparing").length}</i>}</button>)}</div><div className="table-actions"><div className="search-box compact"><Search size={15}/><input placeholder="Search orders" value={search} onChange={(e)=>setSearch(e.target.value)}/></div><button className="filter-button" onClick={() => onNotify("Showing orders for today")}><CalendarDays size={15}/> Today <ChevronDown size={14}/></button></div></div><div className="wide-table"><div className="table-head order-table-head"><span>ORDER DETAILS</span><span>TYPE / TABLE</span><span>ITEMS</span><span>STATUS</span>{showFinancials && <><span>PAYMENT</span><span>TOTAL</span></>}<span/></div>{visible.map((o) => <div className="order-table-row" key={o.id}><span><b>{o.id}</b><small>{o.time} · {o.customer}{o.syncState ? ` · ${o.syncState === "queued" ? "waiting to sync" : "sync needs attention"}` : ""}</small>{o.syncState === "needs-attention" && <button className="text-link" onClick={() => void onRetrySync(o)}>Retry sync</button>}</span><span>{o.type}<small>{o.table !== "—" ? `Table ${o.table}` : "—"}</small></span><span>{o.items.reduce((s,i)=>s+i.qty,0)} items<small>{o.items[0]?.name}</small></span><span><Status status={o.status}/></span>{showFinancials && <><span><span className={`payment-type ${(o.paidAmount !== undefined && o.paidAmount < o.total ? "partial" : o.payment).toLowerCase()}`}>{o.paidAmount !== undefined && o.paidAmount > 0 && o.paidAmount < o.total ? `Partial · ${fmt(o.paidAmount)}` : o.payment}</span></span><b>{fmt(o.total)}</b></>}<button className="icon-button" onClick={() => { setDetailId(o.id); setRecordAmount(""); setTransferTable((cloudMode ? tables.find((t) => !t.occupied && t.label !== o.table)?.label : o.table === "T-04" ? "T-05" : "T-04") ?? ""); }} aria-label={`View ${o.id}`}><MoreHorizontal size={17}/></button></div>)}{visible.length === 0 && <div className="empty-state"><BookOpen size={23}/><b>No orders here</b><span>Try a different filter.</span></div>}</div><div className="table-bottom"><span>Showing {visible.length} of {orders.length} orders</span><div><button disabled><ChevronLeft size={15}/></button><button className="page-current">1</button><button disabled><ChevronRight size={15}/></button></div></div></div>
    {detail && <div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)setDetailId("");}}><div className="modal order-detail-modal"><button className="modal-close" onClick={()=>setDetailId("")}><X size={18}/></button><p className="eyebrow">ORDER DETAILS · {detail.time}</p><h2>{detail.id} <Status status={detail.status}/></h2><p className="muted">{detail.type}{detail.table !== "—" ? ` · Table ${detail.table}` : ""} · {detail.customer}</p><div className="detail-lines">{detail.items.map((i)=><div key={i.id}><span>{i.qty} × {i.name}</span>{showFinancials && <b>{fmt(i.qty*i.price)}</b>}</div>)}{showFinancials && <>{detail.invoiceDocumentType && <div><span>{detail.invoiceDocumentType.replaceAll("_", " ")}</span><b>{detail.invoiceNumber ?? ""}</b></div>}{detail.supplierGstin && <div><span>Supplier GSTIN</span><b>{detail.supplierGstin}</b></div>}{detail.gstAmount !== undefined && detail.gstAmount > 0 && <div><span>GST</span><b>{fmt(detail.gstAmount)}</b></div>}<div className="detail-total"><span>Bill total</span><b>{fmt(detail.total)}</b></div></>}</div>{showFinancials && <div className="payment-history"><h3>Payments and refunds</h3>{detail.payments?.length ? detail.payments.map((payment) => <div className="payment-history-row" key={payment.id}><div><b>{({ CASH: "Cash", CARD: "Card", UPI: "UPI", OTHER: "Other" } as Record<string, string>)[payment.method] ?? payment.method}</b><small>Captured {fmt(payment.amountPaise / 100)} · refunded {fmt(payment.refundedPaise / 100)} · refundable {fmt(payment.refundablePaise / 100)}</small></div>{canRefund && cloudMode && detail.serverId && payment.method !== "OTHER" && payment.refundablePaise > 0 && <button className="text-link" onClick={() => { setRefundPaymentId(payment.id); setRefundAmount((payment.refundablePaise / 100).toFixed(2)); setRefundReason(""); }}>Refund</button>}{refundPaymentId === payment.id && <div className="refund-entry"><label>Refund amount (₹)<input aria-label="Refund amount in rupees" inputMode="decimal" value={refundAmount} onChange={(event) => setRefundAmount(event.target.value)} /></label><label>Reason<input aria-label="Refund reason" maxLength={300} value={refundReason} onChange={(event) => setRefundReason(event.target.value)} placeholder="Required for audit" /></label><div><button className="secondary-button" onClick={() => setRefundPaymentId("")}>Cancel</button><button className="primary-button" disabled={!refundAmount.trim() || !Number.isFinite(Number(refundAmount)) || Number(refundAmount) <= 0 || Number(refundAmount) * 100 > payment.refundablePaise || refundReason.trim().length < 3} onClick={submitRefund}>Record refund</button></div><small>Records the refund in KORA. Process the money return through the original provider.</small></div>}</div>) : <small>No payment recorded.</small>}</div>}{addItemsOpen && <section className="order-add-items"><div className="order-add-heading"><b>Add items to this order</b><small>New items are sent to the kitchen as a follow-up KOT.</small></div>{products.filter((product)=>product.available&&product.id.length>5).map((product)=><div className="order-add-row" key={product.id}><span><b>{product.name}</b><small>{product.category}{showFinancials?` · ${fmt(product.price)}`:""}</small></span><div><button aria-label={`Remove one ${product.name}`} disabled={!addItemQuantities[product.id]} onClick={()=>setAddItemQuantities((current)=>({...current,[product.id]:Math.max(0,(current[product.id]??0)-1)}))}>−</button><b>{addItemQuantities[product.id]??0}</b><button aria-label={`Add one ${product.name}`} onClick={()=>setAddItemQuantities((current)=>({...current,[product.id]:Math.min(99,(current[product.id]??0)+1)}))}>+</button></div></div>)}<div className="order-add-footer"><button className="secondary-button" onClick={()=>setAddItemsOpen(false)}>Cancel</button><button className="primary-button" disabled={savingAddedItems||!Object.values(addItemQuantities).some((quantity)=>quantity>0)} onClick={()=>void submitAddedItems()}>{savingAddedItems?"Sending…":"Send to kitchen"}</button></div></section>}{canMoveTable && (!cloudMode || detail.serverId) && detail.type==="Dine in" && detail.status!=="Completed" && <div className="form-split transfer-row"><label>Transfer table<select value={transferTable} onChange={(e)=>setTransferTable(e.target.value)}>{(cloudMode ? tables.filter((t) => !t.occupied && t.label !== detail.table).map((t) => t.label) : ["T-04","T-05","T-06","T-08"].filter((t)=>t!==detail.table)).map((t)=><option key={t}>{t}</option>)}</select></label><button className="secondary-button" onClick={transfer}><ArrowRight size={14}/> Move</button></div>}{showFinancials && (!cloudMode || detail.serverId) && detail.paidAmount!==undefined && detail.paidAmount<detail.total && <div className="payment-entry"><span>Remaining balance <b>{fmt(detail.total-detail.paidAmount)}</b></span><div><select aria-label="Payment method" value={recordMethod} onChange={(e) => setRecordMethod(e.target.value as "Cash" | "Card" | "UPI")}><option>Cash</option><option>UPI</option><option>Card</option></select><input aria-label="Payment amount" type="number" min="0.01" max={detail.total-detail.paidAmount} step="0.01" value={recordAmount} onChange={(e)=>setRecordAmount(e.target.value)} placeholder="Amount ₹"/><button className="secondary-button" disabled={!recordAmount || Number(recordAmount)<=0 || Number(recordAmount)>detail.total-detail.paidAmount} onClick={addPayment}>Record payment</button></div></div>}{showFinancials && (!cloudMode || detail.serverId) && detail.paidAmount===undefined && detail.payment==="Pending" && <div className="payment-entry"><span>Bill pending <b>{fmt(detail.total)}</b></span><div><select aria-label="Payment method" value={recordMethod} onChange={(e) => setRecordMethod(e.target.value as "Cash" | "Card" | "UPI")}><option>Cash</option><option>UPI</option><option>Card</option></select><input aria-label="Payment amount" type="number" min="0.01" max={detail.total} step="0.01" value={recordAmount} onChange={(e)=>setRecordAmount(e.target.value)} placeholder="Amount ₹"/><button className="secondary-button" disabled={!recordAmount || Number(recordAmount)<=0 || Number(recordAmount)>detail.total} onClick={addPayment}>Record payment</button></div></div>}<div className="detail-actions">{canEditOrders && cloudMode && detail.serverId && !["Completed","Cancelled"].includes(detail.status) && <button className="secondary-button" onClick={()=>{setAddItemsOpen((value)=>!value);setAddItemQuantities({});}}><Plus size={14}/> Add items</button>}{showFinancials && detail.serverId && <button className="secondary-button" onClick={()=>void onPrintBill(detail)}><Printer size={14}/> Print bill</button>}{cloudMode && !detail.serverId && detail.provisionalEstimate && canSettleBills && <button className="secondary-button" onClick={()=>onPrintOffline(detail,"receipt")}><Printer size={14}/> Print provisional receipt</button>}{cloudMode && !detail.serverId && detail.provisionalEstimate && canPrintKot && <button className="secondary-button" onClick={()=>onPrintOffline(detail,"kot")}><Printer size={14}/> Print kitchen ticket</button>}{canBump && detail.serverId && <button className="secondary-button" onClick={()=>onNotify(`${detail.id} · KOT ${detail.status.toUpperCase()}`)}><Flame size={14}/> View KOT</button>}{canBump && detail.serverId && detail.status!=="Served"&&detail.status!=="Completed"&&<button className="primary-button" onClick={()=>advance(detail)}>{detail.status==="Preparing"?"Mark ready":"Mark served"}<ArrowRight size={14}/></button>}</div></div></div>}
  </>;
}

function KitchenPage({ orders, setData, onNotify, onStatusChange }: { orders: Order[]; setData: React.Dispatch<React.SetStateAction<AppData>>; onNotify: (s:string)=>void; onStatusChange: (order: Order, status: string) => Promise<void> }) {
  const active = orders.filter((o)=>["Preparing","Ready"].includes(o.status));
  const update = (order:Order) => { const status=order.status==="Preparing"?"Ready":"Served"; void onStatusChange(order,status); };
  return <><div className="page-title-row"><div><p className="eyebrow">KITCHEN DISPLAY</p><h1>Kitchen tickets <span className="live-tag"><i/> LIVE</span></h1><p className="muted">New items appear as soon as they’re sent from the POS.</p></div><button className="secondary-button" onClick={()=>onNotify("Kitchen tickets refreshed")}><Activity size={15}/> Refresh</button></div><div className="kitchen-summary"><span><i className="live-dot"/> {active.length} active tickets</span><span>Average prep time <b>14 min</b></span><span>Sorted by oldest first</span></div><div className="kitchen-grid">{active.map((o,i)=><article className={`kitchen-ticket ${o.status.toLowerCase()}`} key={o.id}><div className="ticket-top"><span className="ticket-no">{o.id} <small>· {o.type}{o.table!=="—"?` · ${o.table}`:""}</small></span><span className="ticket-time"><Clock3 size={12}/>{o.time}</span></div><div className="ticket-status"><Status status={o.status}/><span>KOT #{i+1}</span></div><div className="ticket-items">{o.items.map((item)=><div key={item.id}><b>{item.qty}×</b><span>{item.name}</span><small>{item.note??""}</small></div>)}</div><button className={o.status==="Preparing"?"primary-button":"secondary-button"} onClick={()=>update(o)}>{o.status==="Preparing"?"Mark order ready":"Mark as served"}<ArrowRight size={14}/></button></article>)}{!active.length&&<div className="empty-state"><CheckCircle2 size={25}/><b>Kitchen is all caught up</b><span>New KOTs will show up here.</span></div>}</div></>;
}

function MenuPage({ data, setData, onAdd, onNotify, onAvailabilityChange, onTaxCodeChange, cloudMode, canEditMenu, canEditTax }: { data: AppData; setData: React.Dispatch<React.SetStateAction<AppData>>; onAdd: () => void; onNotify: (s: string) => void; onAvailabilityChange: (product: Product) => Promise<void>; onTaxCodeChange: (product: Product, kind: "HSN" | "SAC" | null, code: string | null) => Promise<void>; cloudMode: boolean; canEditMenu: boolean; canEditTax: boolean }) {
  const [tab, setTab] = useState("All items");
  const cats = ["All items", ...Array.from(new Set(data.products.map((product) => product.category)))];
  const list = data.products.filter((product) => tab === "All items" || product.category === tab);
  return <>
    <div className="page-title-row"><div><p className="eyebrow">CATALOGUE</p><h1>Your menu</h1><p className="muted">Manage dishes, prices, and what’s on the menu today.</p></div>{canEditMenu && <button className="primary-button" onClick={onAdd}><Plus size={16}/> Add dish</button>}</div>
    <div className="menu-kpis"><div><span>Menu items</span><b>{data.products.length}</b><small>Across {cats.length - 1} categories</small></div><div><span>Available today</span><b>{data.products.filter((product) => product.available).length}</b><small>Ready to order</small></div><div><span>Out of stock</span><b>{data.products.filter((product) => !product.available).length}</b><small>Hidden from POS</small></div></div>
    {cloudMode && canEditTax && <div className="menu-tax-notice">Every item on a GST Tax Invoice needs an accountant-assigned HSN/SAC code. Codes are snapshotted on each order line.</div>}
    <div className="card content-card"><div className="table-toolbar"><div className="tabs menu-tabs">{cats.map((name) => <button className={tab === name ? "active" : ""} key={name} onClick={() => setTab(name)}>{name}</button>)}</div><button className="filter-button" onClick={() => onNotify("Menu display preferences saved")}><ListFilter size={15}/> Sort</button></div>
      <div className="menu-list">{list.map((product) => <div className={`menu-product-row ${!product.available ? "unavailable" : ""}`} key={product.id}>
        <div className="menu-row"><span className={`seller-emoji tone-${data.products.indexOf(product) % 4}`}>{product.emoji}</span><span className="menu-row-main"><b>{product.name}</b><small>{product.category}</small></span><span className="menu-price">{fmt(product.price)}</span><span className={`availability ${product.available ? "in-stock" : "out-stock"}`}><i/>{product.available ? "Available" : "Out of stock"}</span>{canEditMenu && <button className={`switch ${product.available ? "on" : ""}`} aria-label={`Toggle ${product.name} availability`} onClick={() => cloudMode ? void onAvailabilityChange(product) : setData((current) => ({ ...current, products: current.products.map((item) => item.id === product.id ? { ...item, available: !item.available } : item) }))}><i/></button>}<button className="icon-button" onClick={() => onNotify(`Editing ${product.name} is ready in the full menu editor`)}><MoreHorizontal size={17}/></button></div>
        {cloudMode && <TaxClassificationEditor product={product} canEdit={canEditTax} onSave={onTaxCodeChange} />}
      </div>)}</div><div className="table-bottom"><span>Showing {list.length} menu items</span><button className="text-link" onClick={() => onNotify(cloudMode ? "Changes saved to KORA cloud" : "Menu changes are saved automatically")}>{cloudMode ? "Cloud synced" : "Changes saved"} <CheckCircle2 size={14}/></button></div></div>
  </>;
}

function TaxClassificationEditor({ product, canEdit, onSave }: { product: Product; canEdit: boolean; onSave: (product: Product, kind: "HSN" | "SAC" | null, code: string | null) => Promise<void> }) {
  const [kind, setKind] = useState<"" | "HSN" | "SAC">(product.taxCodeKind ?? "");
  const [code, setCode] = useState(product.taxCode ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setKind(product.taxCodeKind ?? ""); setCode(product.taxCode ?? ""); }, [product.taxCode, product.taxCodeKind]);
  const save = async () => {
    setError(""); setSaving(true);
    try { await onSave(product, code.trim() ? kind || null : null, code.trim() || null); }
    catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Could not save HSN/SAC."); }
    finally { setSaving(false); }
  };
  if (!canEdit) return <div className="menu-tax-readonly">{product.taxCodeKind && product.taxCode ? `${product.taxCodeKind} ${product.taxCode}` : "HSN/SAC not assigned"}</div>;
  return <div className="menu-tax-editor"><span>Invoice tax code</span><select aria-label={`${product.name} HSN or SAC`} value={kind} onChange={(event) => setKind(event.target.value as "" | "HSN" | "SAC")}><option value="">Select type</option><option value="HSN">HSN · goods</option><option value="SAC">SAC · services</option></select><input aria-label={`${product.name} tax code`} inputMode="numeric" maxLength={8} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder={kind === "SAC" ? "6 digits" : "2–8 digits"}/><button className="secondary-button" disabled={saving || (code.trim() === (product.taxCode ?? "") && kind === (product.taxCodeKind ?? ""))} onClick={() => void save()}>{saving ? "Saving…" : "Save code"}</button>{error && <small role="alert">{error}</small>}</div>;
}

function InventoryPage({ products, onNotify }: { products: Product[]; onNotify: (s:string)=>void }) {
 const [tab,setTab]=useState("Stock levels"); const materials=[{n:"Basmati rice",cat:"Grains & pulses",qty:"18.5 kg",min:"10 kg",status:"Healthy",cost:"₹1,850"},{n:"Paneer",cat:"Dairy",qty:"4.2 kg",min:"5 kg",status:"Low stock",cost:"₹2,100"},{n:"Cooking oil",cat:"Oils & spices",qty:"12 L",min:"8 L",status:"Healthy",cost:"₹1,440"},{n:"Tomatoes",cat:"Fresh produce",qty:"2.4 kg",min:"5 kg",status:"Low stock",cost:"₹192"},{n:"Chicken",cat:"Meat & poultry",qty:"8.0 kg",min:"4 kg",status:"Healthy",cost:"₹2,800"},{n:"Moong dal",cat:"Grains & pulses",qty:"0 kg",min:"3 kg",status:"Out of stock",cost:"₹0"}];
 return <><div className="page-title-row"><div><p className="eyebrow">BACK OF HOUSE</p><h1>Inventory</h1><p className="muted">Know what’s in stock before the kitchen runs out.</p></div><div className="title-actions"><button className="secondary-button" onClick={()=>onNotify("Stock movement report downloaded")}><Download size={15}/> Export</button><button className="primary-button" onClick={()=>onNotify("Purchase order draft created")}><Plus size={16}/> New purchase</button></div></div><div className="stats-grid inventory-stats"><StatCard icon={Box} label="Stock value" value="₹84,320" note="across all items" change="↑ 3.4%" good/><StatCard icon={Activity} label="Stock items" value="48" note="tracked ingredients" change="+ 4 this month" good/><StatCard icon={ArrowDownRight} label="Low stock alerts" value="3 items" note="need attention" change="View items"/></div><div className="card content-card"><div className="table-toolbar"><div className="tabs">{["Stock levels","Recipes","Purchases","Wastage"].map(x=><button className={tab===x?"active":""} key={x} onClick={()=>setTab(x)}>{x}</button>)}</div><button className="filter-button" onClick={()=>onNotify("Filter options: outlet, category, and stock status")}><Filter size={15}/> Filter</button></div>{tab==="Stock levels"?<div className="wide-table"><div className="table-head inventory-head"><span>INGREDIENT</span><span>CATEGORY</span><span>ON HAND</span><span>MINIMUM</span><span>STATUS</span><span>VALUE</span><span/></div>{materials.map((m,i)=><div className="inventory-row" key={m.n}><span><i className={`ingredient-dot ingredient-${i}`}/><b>{m.n}</b></span><span>{m.cat}</span><span><b>{m.qty}</b></span><span>{m.min}</span><span><Status status={m.status}/></span><b>{m.cost}</b><button className="icon-button" onClick={()=>onNotify(`Stock adjustment started for ${m.n}`)}><MoreHorizontal size={17}/></button></div>)}</div>:<div className="feature-placeholder"><span className="feature-icon"><Package size={22}/></span><h3>{tab} workspace</h3><p>Ingredient recipes, vendor purchases, and waste logs are ready to configure for your outlet.</p><button className="primary-button" onClick={()=>onNotify(`${tab} setup started`)}><Plus size={15}/> Add {tab === "Recipes" ? "recipe" : tab === "Purchases" ? "purchase" : "wastage log"}</button></div>}<div className="table-bottom"><span>Inventory updates are recorded by outlet</span><button className="text-link" onClick={()=>onNotify("Inventory synced")}><CheckCircle2 size={14}/> Synced</button></div></div><div className="inventory-hint"><Sparkles size={16}/><span><b>Recipe-linked deductions</b><small>Connect menu items to recipes and ingredient stock will adjust automatically after every sale.</small></span><button onClick={()=>setTab("Recipes")}>Set up recipes <ArrowRight size={14}/></button></div><div className="sr-only">{products.length} menu products</div></>;
}

function CustomersPage({ customers, onAdd, canManage }: { customers: AppData["customers"]; onAdd: ()=>void; canManage: boolean }) { return <><div className="page-title-row"><div><p className="eyebrow">GUEST RELATIONSHIPS</p><h1>Customers</h1><p className="muted">Every regular has a story. Keep it close.</p></div>{canManage && <button className="primary-button" onClick={onAdd}><Plus size={16}/> Add customer</button>}</div><div className="stats-grid customer-stats"><StatCard icon={Users} label="Total guests" value="1,284" note="vs. last month" change="↑ 14.2%" good/><StatCard icon={Star} label="Returning guests" value="38.6%" note="repeat visit rate" change="↑ 2.1%" good/><StatCard icon={Gift} label="Loyalty points issued" value="24,680" note="this month" change="↑ 8.4%" good/><StatCard icon={TrendingUp} label="Guest lifetime value" value="₹2,840" note="average per guest" change="↑ 5.6%" good/></div><div className="card content-card"><div className="table-toolbar"><div><h2 className="section-title">Guest book <span className="count-bubble">{customers.length}</span></h2></div><div className="table-actions"><div className="search-box compact"><Search size={15}/><input placeholder="Find a guest"/></div><button className="filter-button"><ListFilter size={15}/> Filter</button></div></div><div className="wide-table"><div className="table-head customer-head"><span>GUEST</span><span>PHONE</span><span>VISITS</span><span>LIFETIME SPEND</span><span>LOYALTY</span><span/></div>{customers.map((c,i)=><div className="customer-row" key={c.phone}><span className="customer-name-cell"><i className={`avatar avatar-${i%4}`}>{initials(c.name)}</i><b>{c.name}</b></span><span>{c.phone}</span><span>{c.visits} visits</span><b>{fmt(c.spend)}</b><span className="loyalty-points"><Star size={13}/>{(c.visits*120).toLocaleString("en-IN")} pts</span><button className="icon-button" aria-label={`More about ${c.name}`}><MoreHorizontal size={17}/></button></div>)}</div><div className="table-bottom"><span>Showing {customers.length} guests</span><button className="text-link">Customer insights <ArrowRight size={14}/></button></div></div></>; }

function TeamPage({onNotify}:{onNotify:(s:string)=>void}){const rows=[{n:"Arjun Sharma",r:"Owner",p:"Full access",s:"Active",a:"AS"},{n:"Priya Menon",r:"Manager",p:"Outlet management",s:"Active",a:"PM"},{n:"Rohan Das",r:"Cashier",p:"Billing & shifts",s:"Active",a:"RD"},{n:"Isha Kapoor",r:"Kitchen",p:"KOT & menu",s:"Active",a:"IK"},{n:"Dev Patel",r:"Waiter",p:"Orders & tables",s:"Invited",a:"DP"}];return <><div className="page-title-row"><div><p className="eyebrow">PEOPLE & ACCESS</p><h1>Your team</h1><p className="muted">Good service starts with a great crew.</p></div><button className="primary-button" onClick={()=>onNotify("Invite link copied to clipboard")}><Plus size={16}/> Invite team member</button></div><div className="team-banner"><span className="team-banner-icon"><ShieldCheck size={20}/></span><span><b>Roles keep every shift running smoothly</b><small>Only owners and managers can approve discounts and void bills.</small></span><button onClick={()=>onNotify("Role permissions opened")}>Manage permissions <ArrowRight size={14}/></button></div><div className="card content-card"><div className="table-toolbar"><div><h2 className="section-title">Team members <span className="count-bubble">5</span></h2></div><button className="filter-button" onClick={()=>onNotify("Showing all outlet team members")}><Store size={14}/> Indiranagar <ChevronDown size={14}/></button></div><div className="wide-table"><div className="table-head team-head"><span>TEAM MEMBER</span><span>ROLE</span><span>ACCESS</span><span>STATUS</span><span>LAST ACTIVE</span><span/></div>{rows.map((r,i)=><div className="team-row" key={r.n}><span className="customer-name-cell"><i className={`avatar avatar-${i%4}`}>{r.a}</i><b>{r.n}</b></span><span className="role-tag">{r.r}</span><span>{r.p}</span><span><Status status={r.s}/></span><span>{i===0?"Now":i===4?"Invitation sent":"Today, 9:12 AM"}</span><button className="icon-button" onClick={()=>onNotify(`Team profile opened for ${r.n}`)}><MoreHorizontal size={17}/></button></div>)}</div><div className="table-bottom"><span>5 members · Free plan includes 1 user</span><button className="text-link" onClick={()=>onNotify("Explore KORA Plus for unlimited team seats")}>Upgrade plan <ArrowUpRight size={14}/></button></div></div></>;}

function ReportsPage({range,setRange,todaySales,onNotify}:{range:string;setRange:(s:string)=>void;todaySales:number;onNotify:(s:string)=>void}){return <><div className="page-title-row"><div><p className="eyebrow">INSIGHTS</p><h1>Reports</h1><p className="muted">Clear numbers, so you can focus on the food.</p></div><div className="title-actions"><select className="date-select" value={range} onChange={e=>setRange(e.target.value)}><option>Today</option><option>This week</option><option>This month</option></select><button className="secondary-button" onClick={()=>onNotify("Your report is ready to download")}><Download size={15}/> Export report</button></div></div><div className="stats-grid"><StatCard icon={BadgeIndianRupee} label="Net sales" value={fmt(todaySales*0.95)} note="after discounts & tax" change="↑ 12.8%" good/><StatCard icon={ShoppingBag} label="Orders" value="46" note="vs. previous period" change="↑ 8.2%" good/><StatCard icon={IndianRupee} label="Average order" value={fmt(Math.round(todaySales/46))} note="per transaction" change="↑ 4.1%" good/><StatCard icon={CreditCard} label="GST collected" value={fmt(todaySales*0.05)} note="5% food GST" change="View summary"/></div><div className="dashboard-grid report-grid"><section className="card sales-card"><div className="card-heading"><div><h2>Sales trend</h2><p>{range} · compared to previous period</p></div><button className="icon-button" onClick={()=>onNotify("Sales chart exported")}>···</button></div><div className="report-bars">{[35,49,41,66,54,78,61,84,70,93,76,100].map((_,i)=><div className="bar-pair" key={i}><i/><b/><small>{["8","9","10","11","12","1","2","3","4","5","6","7"][i]}</small></div>)}</div><div className="report-chart-legend"><span><i/> This period</span><span><i/> Previous period</span></div></section><section className="card channel-card"><div className="card-heading"><div><h2>Payment mix</h2><p>How guests paid today</p></div></div><div className="payment-mix"><div><span>UPI</span><b>48%</b><i><i/></i><small>₹{Math.round(todaySales*.48).toLocaleString("en-IN")}</small></div><div><span>Cash</span><b>31%</b><i><i/></i><small>₹{Math.round(todaySales*.31).toLocaleString("en-IN")}</small></div><div><span>Card</span><b>21%</b><i><i/></i><small>₹{Math.round(todaySales*.21).toLocaleString("en-IN")}</small></div></div></section></div><div className="report-shortcuts"><button onClick={()=>onNotify("GST summary CSV prepared")}><FileDown size={17}/><span><b>GST summary</b><small>Tax collected by rate</small></span><ArrowDownRight size={15}/></button><button onClick={()=>onNotify("Shift report prepared")}><Wallet size={17}/><span><b>Shift report</b><small>Cashier reconciliation</small></span><ArrowDownRight size={15}/></button><button onClick={()=>onNotify("Top and bottom items report prepared")}><Flame size={17}/><span><b>Item performance</b><small>Top & bottom sellers</small></span><ArrowDownRight size={15}/></button></div></>;}

function SettingsPage({data,setData,onNotify}:{data:AppData;setData:React.Dispatch<React.SetStateAction<AppData>>;onNotify:(s:string)=>void}){return <><div className="page-title-row"><div><p className="eyebrow">YOUR BUSINESS</p><h1>Settings</h1><p className="muted">Make KORA work the way your restaurant does.</p></div><button className="primary-button" onClick={()=>onNotify("Settings saved successfully")}><Check size={15}/> Save changes</button></div><div className="settings-grid"><div className="settings-nav card">{["Restaurant profile","Outlets & tables","Billing & GST","Receipt & printer","Language & display","Plan & billing"].map((x,i)=><button key={x} className={i===0?"active":""} onClick={()=>onNotify(`${x} settings selected`)}>{[Store,House,BadgeIndianRupee,Printer,Command,Star].map((Icon,j)=>j===i?<Icon key={j} size={16}/>:null)}{x}<ChevronRight size={14}/></button>)}</div><div className="card settings-content"><p className="eyebrow">RESTAURANT PROFILE</p><h2>The Saffron Room</h2><p className="muted">This information appears on your bills and GST invoices.</p><div className="settings-form"><label>Restaurant name<input defaultValue="The Saffron Room"/></label><label>Legal business name<input defaultValue="Saffron Hospitality LLP"/></label><div className="form-split"><label>Phone number<input defaultValue="+91 80412 34567"/></label><label>Business email<input defaultValue="hello@saffronroom.in"/></label></div><label>Address<input defaultValue="12th Main Road, Indiranagar, Bengaluru, Karnataka 560038"/></label><div className="form-split"><label>GSTIN<input defaultValue="29AAXXX1234X1Z5"/></label><label>FSSAI license<input defaultValue="11223344556677"/></label></div><div className="settings-divider"/><p className="settings-subhead">Preferences</p><div className="setting-option"><span><b>Interface language</b><small>Choose the language used across KORA.</small></span><select value={data.language} onChange={e=>setData(d=>({...d,language:e.target.value}))}><option>English</option><option>हिन्दी</option></select></div><div className="setting-option"><span><b>GST on food items</b><small>Default tax rate applied to menu items.</small></span><span className="tax-pill">5% GST</span></div><div className="setting-option"><span><b>Service charge</b><small>Optional 5% charge applied to dine-in orders.</small></span><button className={`switch ${data.serviceChargeBps>0?"on":""}`} aria-label="Toggle service charge" onClick={()=>{const enabled=data.serviceChargeBps===0;setData(d=>({...d,serviceChargeBps:enabled?500:0}));onNotify(enabled?"5% dine-in service charge enabled":"Service charge disabled");}}><i/></button></div></div></div></div></>;}
