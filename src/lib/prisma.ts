import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient } from "@prisma/client";
import { applyPrismaTenantScope, type PrismaTenantScope } from "@/lib/tenant-scope";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const tenantScopeStorage = new AsyncLocalStorage<PrismaTenantScope>();

/** Unscoped client for authentication/bootstrap operations only. */
export const rootPrisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = rootPrisma;

export function runWithPrismaTenantScope<T>(scope: PrismaTenantScope, callback: () => T): T {
  return tenantScopeStorage.run(scope, callback);
}

const tenantScopedPrisma = rootPrisma.$extends({
  name: "kora-tenant-scope",
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        const scope = tenantScopeStorage.getStore();
        if (!scope || !model) return query(args);
        // Prisma's all-model extension is dynamically keyed by model name; the policy
        // function preserves the operation's inferred arguments at this boundary.
        return query(applyPrismaTenantScope(model, operation, args, scope) as typeof args);
      },
    },
  },
});

// The extension adds no new delegates; keep PrismaClient's generated transaction
// types so existing domain seed helpers remain compatible with transaction clients.
export const prisma = tenantScopedPrisma as unknown as PrismaClient;
