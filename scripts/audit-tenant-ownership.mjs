import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const sql = `
WITH violations(issue) AS (
  SELECT 'roles.outlet_tenant' FROM public.roles r LEFT JOIN public.outlets o ON o.id = r."outletId"
    WHERE (r."outletId" IS NOT NULL AND (r."tenantId" IS DISTINCT FROM o."tenantId" OR r."tenantId" IS NULL))
       OR (r."tenantId" IS NULL AND (r."outletId" IS NOT NULL OR r.name IS DISTINCT FROM 'SUPER_ADMIN' OR r."isSystem" IS DISTINCT FROM TRUE))
  UNION ALL
  SELECT 'user_outlet_roles.ownership' FROM public.user_outlet_roles a
    LEFT JOIN public.users u ON u.id = a."userId"
    LEFT JOIN public.outlets o ON o.id = a."outletId"
    LEFT JOIN public.roles r ON r.id = a."roleId"
    WHERE u."tenantId" IS DISTINCT FROM o."tenantId" OR r."tenantId" IS DISTINCT FROM o."tenantId"
       OR (r."outletId" IS NOT NULL AND r."outletId" IS DISTINCT FROM a."outletId")
  UNION ALL
  SELECT 'user_platform_roles.role' FROM public.user_platform_roles a
    LEFT JOIN public.roles r ON r.id = a."roleId"
    WHERE r."tenantId" IS NOT NULL OR r."outletId" IS NOT NULL OR r.name IS DISTINCT FROM 'SUPER_ADMIN' OR r."isSystem" IS DISTINCT FROM TRUE
  UNION ALL
  SELECT 'customer_outlets.tenant' FROM public.customer_outlets a
    LEFT JOIN public.customers c ON c.id = a."customerId"
    LEFT JOIN public.outlets o ON o.id = a."outletId"
    WHERE c."tenantId" IS DISTINCT FROM o."tenantId"
  UNION ALL
  SELECT 'menu_categories.ownership' FROM public.menu_categories c
    LEFT JOIN public.outlets o ON o.id = c."outletId"
    LEFT JOIN public.menu_categories p ON p.id = c."parentId"
    WHERE (c."outletId" IS NOT NULL AND c."tenantId" IS DISTINCT FROM o."tenantId")
       OR (c."parentId" IS NOT NULL AND (p."tenantId" IS DISTINCT FROM c."tenantId"
         OR (c."outletId" IS NULL AND p."outletId" IS NOT NULL)
         OR (c."outletId" IS NOT NULL AND p."outletId" IS NOT NULL AND p."outletId" IS DISTINCT FROM c."outletId")))
  UNION ALL
  SELECT 'menu_items.category_tenant' FROM public.menu_items i
    LEFT JOIN public.menu_categories c ON c.id = i."categoryId"
    WHERE i."tenantId" IS DISTINCT FROM c."tenantId"
  UNION ALL
  SELECT 'outlet_menu_items.ownership' FROM public.outlet_menu_items i
    LEFT JOIN public.outlets o ON o.id = i."outletId"
    LEFT JOIN public.menu_items m ON m.id = i."menuItemId"
    LEFT JOIN public.stations s ON s.id = i."stationId"
    WHERE o."tenantId" IS DISTINCT FROM m."tenantId"
       OR (i."stationId" IS NOT NULL AND s."outletId" IS DISTINCT FROM i."outletId")
  UNION ALL
  SELECT 'orders.ownership' FROM public.orders o
    LEFT JOIN public.outlets outlet ON outlet.id = o."outletId"
    LEFT JOIN public.customers c ON c.id = o."customerId"
    LEFT JOIN public.restaurant_tables t ON t.id = o."tableId"
    LEFT JOIN public.users u ON u.id = o."createdById"
    WHERE o."tenantId" IS DISTINCT FROM outlet."tenantId"
       OR (o."customerId" IS NOT NULL AND o."tenantId" IS DISTINCT FROM c."tenantId")
       OR (o."tableId" IS NOT NULL AND o."outletId" IS DISTINCT FROM t."outletId")
       OR (o."createdById" IS NOT NULL AND o."tenantId" IS DISTINCT FROM u."tenantId")
  UNION ALL
  SELECT 'order_items.menu_tenant' FROM public.order_items i
    JOIN public.orders o ON o.id = i."orderId"
    LEFT JOIN public.menu_items m ON m.id = i."menuItemId"
    WHERE i."menuItemId" IS NOT NULL AND o."tenantId" IS DISTINCT FROM m."tenantId"
  UNION ALL
  SELECT 'kots.ownership' FROM public.kots k
    LEFT JOIN public.orders o ON o.id = k."orderId"
    LEFT JOIN public.outlets outlet ON outlet.id = k."outletId"
    LEFT JOIN public.stations s ON s.id = k."stationId"
    WHERE k."outletId" IS DISTINCT FROM o."outletId"
       OR o."tenantId" IS DISTINCT FROM outlet."tenantId"
       OR (k."stationId" IS NOT NULL AND k."outletId" IS DISTINCT FROM s."outletId")
  UNION ALL
  SELECT 'kot_items.order' FROM public.kot_items i
    LEFT JOIN public.kots k ON k.id = i."kotId"
    LEFT JOIN public.order_items oi ON oi.id = i."orderItemId"
    WHERE k."orderId" IS DISTINCT FROM oi."orderId"
  UNION ALL
  SELECT 'kot_mutations.ownership' FROM public.kot_mutations m
    LEFT JOIN public.outlets o ON o.id = m."outletId"
    LEFT JOIN public.users u ON u.id = m."userId"
    LEFT JOIN public.kots k ON k.id = m."ticketId"
    WHERE o."tenantId" IS DISTINCT FROM u."tenantId"
       OR (m."ticketId" IS NOT NULL AND m."outletId" IS DISTINCT FROM k."outletId")
  UNION ALL
  SELECT 'bills.order' FROM public.bills b
    LEFT JOIN public.orders o ON o.id = b."orderId"
    WHERE b."tenantId" IS DISTINCT FROM o."tenantId" OR b."outletId" IS DISTINCT FROM o."outletId"
  UNION ALL
  SELECT 'payments.shift_outlet' FROM public.payments p
    JOIN public.bills b ON b.id = p."billId"
    LEFT JOIN public.shifts s ON s.id = p."shiftId"
    WHERE p."shiftId" IS NOT NULL AND b."outletId" IS DISTINCT FROM s."outletId"
  UNION ALL
  SELECT 'payment_reversals.ownership' FROM public.payment_reversals r
    LEFT JOIN public.payments p ON p.id = r."paymentId"
    LEFT JOIN public.bills b ON b.id = p."billId"
    LEFT JOIN public.outlets o ON o.id = r."outletId"
    LEFT JOIN public.users u ON u.id = r."createdById"
    LEFT JOIN public.shifts s ON s.id = r."shiftId"
    WHERE r."tenantId" IS DISTINCT FROM b."tenantId"
       OR r."outletId" IS DISTINCT FROM b."outletId"
       OR r."tenantId" IS DISTINCT FROM o."tenantId"
       OR r."tenantId" IS DISTINCT FROM u."tenantId"
       OR (r."shiftId" IS NOT NULL AND r."outletId" IS DISTINCT FROM s."outletId")
       OR r.method IS DISTINCT FROM p.method
  UNION ALL
  SELECT 'bill_split_items.order' FROM public.bill_split_items i
    LEFT JOIN public.bill_splits s ON s.id = i."splitId"
    LEFT JOIN public.bills b ON b.id = s."billId"
    LEFT JOIN public.order_items oi ON oi.id = i."orderItemId"
    WHERE b."orderId" IS DISTINCT FROM oi."orderId"
  UNION ALL
  SELECT 'shifts.ownership' FROM public.shifts s
    LEFT JOIN public.outlets o ON o.id = s."outletId"
    LEFT JOIN public.users u ON u.id = s."userId"
    WHERE s."tenantId" IS DISTINCT FROM o."tenantId" OR s."tenantId" IS DISTINCT FROM u."tenantId"
  UNION ALL
  SELECT 'loyalty_transactions.customer_order' FROM public.loyalty_transactions l
    LEFT JOIN public.customers c ON c.id = l."customerId"
    LEFT JOIN public.orders o ON o.id = l."orderId"
    WHERE l."orderId" IS NOT NULL AND (c."tenantId" IS DISTINCT FROM o."tenantId" OR o."customerId" IS DISTINCT FROM l."customerId")
  UNION ALL
  SELECT 'feedback.ownership' FROM public.feedback f
    LEFT JOIN public.outlets outlet ON outlet.id = f."outletId"
    LEFT JOIN public.customers c ON c.id = f."customerId"
    LEFT JOIN public.orders o ON o.id = f."orderId"
    WHERE (f."customerId" IS NOT NULL AND outlet."tenantId" IS DISTINCT FROM c."tenantId")
       OR (f."orderId" IS NOT NULL AND (f."outletId" IS DISTINCT FROM o."outletId"
         OR (f."customerId" IS NOT NULL AND o."customerId" IS DISTINCT FROM f."customerId")))
  UNION ALL
  SELECT 'raw_materials.outlet_tenant' FROM public.raw_materials m
    LEFT JOIN public.outlets o ON o.id = m."outletId"
    WHERE m."tenantId" IS DISTINCT FROM o."tenantId"
  UNION ALL
  SELECT 'recipes.ownership' FROM public.recipes r
    LEFT JOIN public.menu_items i ON i.id = r."menuItemId"
    LEFT JOIN public.outlets o ON o.id = r."outletId"
    LEFT JOIN public.outlet_menu_items omi ON omi."outletId" = r."outletId" AND omi."menuItemId" = r."menuItemId"
    WHERE r."tenantId" IS DISTINCT FROM i."tenantId"
       OR r."tenantId" IS DISTINCT FROM o."tenantId"
       OR omi."menuItemId" IS NULL
  UNION ALL
  SELECT 'recipe_ingredients.outlet' FROM public.recipe_ingredients ri
    LEFT JOIN public.recipes r ON r.id = ri."recipeId"
    LEFT JOIN public.raw_materials m ON m.id = ri."rawMaterialId"
    WHERE r."tenantId" IS DISTINCT FROM m."tenantId"
       OR r."outletId" IS DISTINCT FROM m."outletId"
  UNION ALL
  SELECT 'purchases.ownership' FROM public.purchases p
    LEFT JOIN public.outlets o ON o.id = p."outletId"
    LEFT JOIN public.vendors v ON v.id = p."vendorId"
    WHERE p."tenantId" IS DISTINCT FROM o."tenantId"
       OR (p."vendorId" IS NOT NULL AND p."tenantId" IS DISTINCT FROM v."tenantId")
  UNION ALL
  SELECT 'purchase_lines.outlet' FROM public.purchase_lines l
    LEFT JOIN public.purchases p ON p.id = l."purchaseId"
    LEFT JOIN public.raw_materials m ON m.id = l."rawMaterialId"
    WHERE p."outletId" IS DISTINCT FROM m."outletId"
  UNION ALL
  SELECT 'stock_movements.outlet' FROM public.stock_movements m
    LEFT JOIN public.raw_materials r ON r.id = m."rawMaterialId"
    WHERE m."outletId" IS DISTINCT FROM r."outletId"
  UNION ALL
  SELECT 'wastage.outlet' FROM public.wastage w
    LEFT JOIN public.raw_materials r ON r.id = w."rawMaterialId"
    WHERE w."outletId" IS DISTINCT FROM r."outletId"
  UNION ALL
  SELECT 'sync_queue.ownership' FROM public.sync_queue s
    LEFT JOIN public.outlets o ON o.id = s."outletId"
    WHERE s."tenantId" IS DISTINCT FROM o."tenantId"
  UNION ALL
  SELECT 'audit_logs.ownership' FROM public.audit_logs a
    LEFT JOIN public.outlets o ON o.id = a."outletId"
    LEFT JOIN public.users u ON u.id = a."userId"
    LEFT JOIN public.users approver ON approver.id = a."approvalUserId"
    WHERE (a."outletId" IS NOT NULL AND a."tenantId" IS DISTINCT FROM o."tenantId")
       OR (a."userId" IS NOT NULL AND a."tenantId" IS DISTINCT FROM u."tenantId")
       OR (a."approvalUserId" IS NOT NULL AND a."tenantId" IS DISTINCT FROM approver."tenantId")
)
SELECT issue, COUNT(*)::text AS row_count
FROM violations
GROUP BY issue
ORDER BY issue
`;

try {
  const violations = await prisma.$queryRawUnsafe(sql);
  if (violations.length === 0) {
    console.log('Tenant/outlet ownership audit passed: no mismatches found.');
  } else {
    for (const violation of violations) console.error(`${violation.issue}: ${violation.row_count} row(s)`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Tenant/outlet ownership audit failed to run:', error instanceof Error ? error.message : 'unknown database error');
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
