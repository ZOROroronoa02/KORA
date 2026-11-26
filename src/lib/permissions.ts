export const permissionDescriptions = {
  "orders.read": "Read orders in the assigned outlet",
  "orders.create": "Create orders",
  "orders.edit": "Edit active orders",
  "orders.void": "Void unpaid orders",
  "orders.move_table": "Move a dine-in order to another table",
  "orders.merge": "Merge tables or orders",
  "kot.print": "Print a kitchen order ticket",
  "kot.reprint": "Reprint a kitchen order ticket",
  "bills.create": "Create bills",
  "bills.settle": "Record bill payments",
  "bills.split": "Split a bill",
  "bills.discount.apply": "Apply discounts within the configured threshold",
  "bills.discount.approve": "Approve discounts above the configured threshold",
  "bills.void": "Void bills",
  "bills.day_close": "Close the business day",
  "bills.refund": "Record payment reversals",
  "shift.open": "Open a cashier shift",
  "shift.close": "Close a cashier shift",
  "menu.view": "View the outlet menu",
  "menu.edit": "Edit menu items and availability",
  "menu.price_edit": "Change menu prices",
  "reports.view.sales": "View sales reports",
  "reports.view.financial": "View financial reports",
  "reports.view.gst": "View GST reports",
  "reports.view.staff_performance": "View staff performance reports",
  "reports.view.kds_sla": "View kitchen SLA reports",
  "kds.view": "View kitchen tickets",
  "kds.bump": "Advance kitchen ticket state",
  "kds.recall": "Recall a kitchen ticket",
  "kds.hold": "Hold a kitchen ticket",
  "inventory.view": "View outlet inventory",
  "inventory.adjust": "Adjust outlet stock",
  "staff.manage": "Manage outlet team members",
  "roles.manage": "Manage outlet roles and permissions",
  "settings.manage": "Manage outlet settings",
  "outlets.manage": "Manage outlets",
  "audit.view": "View sensitive-action audit history",
  "customers.view": "View customer profiles",
  "customers.manage": "Create and update customer profiles",
} as const;

export type PermissionKey = keyof typeof permissionDescriptions;

export const allPermissionKeys = Object.keys(permissionDescriptions) as PermissionKey[];

export const roleNames = [
  "OWNER",
  "RESTAURANT_MANAGER",
  "CASHIER",
  "WAITER",
  "CHEF",
  "ACCOUNTANT",
  "INVENTORY_MANAGER",
] as const;

const keys = (...values: PermissionKey[]) => values;
const reportKeys = allPermissionKeys.filter((key) => key.startsWith("reports.view."));
const kitchenKeys = keys("kds.view", "kds.bump", "kds.recall", "kds.hold");
const inventoryKeys = keys("inventory.view", "inventory.adjust");
const shiftKeys = keys("shift.open", "shift.close");
const billOps = keys("bills.create", "bills.settle", "bills.split", "bills.discount.apply", "bills.void", "bills.day_close", "bills.refund");
const orderOps = keys("orders.read", "orders.create", "orders.edit", "orders.void", "orders.move_table", "orders.merge");

export const systemRolePermissions: Record<(typeof roleNames)[number], PermissionKey[]> = {
  OWNER: allPermissionKeys.filter((key) => key !== "orders.create"),
  RESTAURANT_MANAGER: [
    ...orderOps,
    ...billOps,
    "bills.discount.approve",
    ...shiftKeys,
    "menu.view",
    "menu.edit",
    "menu.price_edit",
    ...kitchenKeys,
    ...inventoryKeys,
    "staff.manage",
    "customers.view",
    "customers.manage",
    "audit.view",
    "reports.view.sales",
    "reports.view.kds_sla",
  ],
  CASHIER: [
    "orders.read", "orders.create", "bills.create", "bills.settle", "bills.split",
    "bills.discount.apply", "shift.open", "shift.close", "menu.view",
  ],
  WAITER: ["orders.read", "orders.create", "orders.edit", "orders.move_table", "orders.merge", "kot.print", "menu.view"],
  CHEF: kitchenKeys,
  ACCOUNTANT: [...reportKeys, "audit.view"],
  INVENTORY_MANAGER: inventoryKeys,
};

export const superAdminPermissions = allPermissionKeys;

/** Permission matching is exact; wildcard-like keys are only role grants, never client claims. */
export function can(user: { permissions?: readonly string[] } | null | undefined, permission: PermissionKey | string) {
  return user?.permissions?.includes(permission) ?? false;
}

export function permissionsForRoles(permissions: readonly string[]) {
  return [...new Set(permissions)].sort();
}
