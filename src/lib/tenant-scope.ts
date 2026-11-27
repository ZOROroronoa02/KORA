export type PrismaTenantScope = { tenantId: string; outletId?: string; userId?: string; platformOutletListing?: boolean };

type ScopePolicy = {
  direct?: (scope: PrismaTenantScope) => Record<string, unknown>;
  related?: (scope: PrismaTenantScope) => Record<string, unknown>;
};

const policies: Record<string, ScopePolicy> = {
  Tenant: { direct: (scope) => ({ id: scope.tenantId }) },
  Outlet: { direct: (scope) => scope.platformOutletListing ? {} : { tenantId: scope.tenantId } },
  User: { direct: (scope) => ({ tenantId: scope.tenantId }) },
  Role: {
    direct: (scope) => ({ tenantId: scope.tenantId }),
    related: (scope) => scope.outletId ? { OR: [{ outletId: null }, { outletId: scope.outletId }] } : {},
  },
  Permission: {},
  RolePermission: {
    related: (scope) => ({ role: { tenantId: scope.tenantId, ...(scope.outletId ? { OR: [{ outletId: null }, { outletId: scope.outletId }] } : {}) } }),
  },
  UserOutletRole: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({ user: { tenantId: scope.tenantId }, outlet: { tenantId: scope.tenantId }, role: { tenantId: scope.tenantId } }),
  },
  UserPlatformRole: { direct: (scope) => scope.userId ? { userId: scope.userId } : {} },
  OutletSettings: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({ outlet: { tenantId: scope.tenantId } }),
  },
  RefreshToken: { related: (scope) => ({ user: { tenantId: scope.tenantId } }) },
  Customer: { direct: (scope) => ({ tenantId: scope.tenantId }) },
  CustomerOutlet: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({ customer: { tenantId: scope.tenantId } }),
  },
  MenuCategory: {
    direct: (scope) => ({ tenantId: scope.tenantId }),
    related: (scope) => scope.outletId ? { OR: [{ outletId: null }, { outletId: scope.outletId }] } : {},
  },
  MenuItem: { direct: (scope) => ({ tenantId: scope.tenantId }) },
  OutletMenuItem: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({
      menuItem: { tenantId: scope.tenantId },
      ...(scope.outletId ? { OR: [{ stationId: null }, { station: { outletId: scope.outletId } }] } : {}),
    }),
  },
  ItemVariant: { related: (scope) => ({ menuItem: { tenantId: scope.tenantId } }) },
  ItemAddon: { related: (scope) => ({ menuItem: { tenantId: scope.tenantId } }) },
  HappyHour: { related: (scope) => ({ menuItem: { tenantId: scope.tenantId } }) },
  RestaurantTable: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({ outlet: { tenantId: scope.tenantId } }),
  },
  Order: { direct: (scope) => ({ tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }) },
  OrderItem: { related: (scope) => ({ order: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } }) },
  KOT: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({ order: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } }),
  },
  KOTItem: {
    related: (scope) => ({ kot: { outletId: scope.outletId, order: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } } }),
  },
  Station: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({ outlet: { tenantId: scope.tenantId } }),
  },
  KOTMutation: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({ outlet: { tenantId: scope.tenantId } }),
  },
  Bill: { direct: (scope) => ({ tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }) },
  Payment: { related: (scope) => ({ bill: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } }) },
  PaymentReversal: {
    direct: (scope) => ({ tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }),
    related: (scope) => ({ payment: { bill: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } } }),
  },
  BillSplit: { related: (scope) => ({ bill: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } }) },
  BillSplitItem: {
    related: (scope) => ({ split: { bill: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } } }),
  },
  Coupon: { direct: (scope) => ({ tenantId: scope.tenantId }) },
  Shift: { direct: (scope) => ({ tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }) },
  TableEvent: { related: (scope) => ({ order: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } }) },
  LoyaltyTransaction: {
    related: (scope) => ({ customer: { tenantId: scope.tenantId }, ...(scope.outletId ? { OR: [{ orderId: null }, { order: { tenantId: scope.tenantId, outletId: scope.outletId } }] } : {}) }),
  },
  Feedback: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({
      OR: [
        { customerId: null },
        { customer: { tenantId: scope.tenantId } },
      ],
      ...(scope.outletId ? { AND: [{ OR: [{ orderId: null }, { order: { tenantId: scope.tenantId, outletId: scope.outletId } }] }] } : {}),
    }),
  },
  Vendor: { direct: (scope) => ({ tenantId: scope.tenantId }) },
  RawMaterial: { direct: (scope) => ({ tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }) },
  Recipe: { direct: (scope) => ({ tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }) },
  RecipeIngredient: {
    related: (scope) => ({ recipe: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }, rawMaterial: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } }),
  },
  Purchase: { direct: (scope) => ({ tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }) },
  PurchaseLine: {
    related: (scope) => ({ purchase: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }, rawMaterial: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } }),
  },
  StockMovement: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({ rawMaterial: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } }),
  },
  Wastage: {
    direct: (scope) => scope.outletId ? { outletId: scope.outletId } : {},
    related: (scope) => ({ rawMaterial: { tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) } }),
  },
  SyncMutation: { direct: (scope) => ({ tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }) },
  AuditLog: { direct: (scope) => ({ tenantId: scope.tenantId, ...(scope.outletId ? { outletId: scope.outletId } : {}) }) },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isCreateOperation(operation: string) {
  return operation === "create" || operation === "createMany" || operation === "createManyAndReturn" || operation === "upsert";
}

function isUpdateOperation(operation: string) {
  return operation === "update" || operation === "updateMany" || operation === "updateManyAndReturn" || operation === "upsert";
}

function mergeWhere(existingValue: unknown, direct: Record<string, unknown>, related: Record<string, unknown>) {
  const existing = asRecord(existingValue);
  const result: Record<string, unknown> = { ...existing, ...direct };
  if (Object.keys(related).length) {
    const currentAnd = result.AND;
    const andParts = Array.isArray(currentAnd) ? currentAnd : currentAnd === undefined ? [] : [currentAnd];
    result.AND = [...andParts, related];
  }
  return result;
}

function scopeWriteData(model: string, value: unknown, direct: Record<string, unknown>, inject: boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => scopeWriteData(model, entry, direct, inject));
  const data = asRecord(value);
  for (const [key, expected] of Object.entries(direct)) {
    const presented = data[key];
    if (presented !== undefined && presented !== expected) {
      throw new Error(`${model} write attempted to change its ${key} scope`);
    }
  }
  return inject ? { ...data, ...direct } : data;
}

/** Apply server-owned tenant/outlet filters to a Prisma model operation. */
export function applyPrismaTenantScope(model: string, operation: string, value: unknown, scope: PrismaTenantScope): unknown {
  const policy = policies[model];
  if (!policy) throw new Error(`No tenant-scope policy is registered for Prisma model ${model}`);
  if (model === "Permission") return value;

  const args = asRecord(value);
  const direct = policy.direct?.(scope) ?? {};
  const related = policy.related?.(scope) ?? {};
  const next: Record<string, unknown> = { ...args };
  if ("where" in args) next.where = mergeWhere(args.where, direct, related);
  else if (operation.startsWith("find") || operation === "count" || operation === "aggregate" || operation === "groupBy" || operation.startsWith("update") || operation.startsWith("delete")) {
    next.where = mergeWhere(undefined, direct, related);
  }
  if (Object.keys(direct).length && isCreateOperation(operation)) {
    if (operation === "upsert") next.create = scopeWriteData(model, args.create, direct, true);
    else next.data = scopeWriteData(model, args.data, direct, true);
  }
  if (Object.keys(direct).length && isUpdateOperation(operation)) {
    if (operation === "upsert") next.update = scopeWriteData(model, args.update, direct, false);
    else next.data = scopeWriteData(model, args.data, direct, false);
  }
  return next;
}
