-- Protect tenant and outlet ownership at the database boundary, including nested writes.
-- Reversal: DROP FUNCTION public.kora_assert_tenant_ownership() CASCADE;
-- CASCADE removes only the triggers created below because they depend on this function.

CREATE OR REPLACE FUNCTION public.kora_assert_tenant_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  immutable_fields text[];
  field_name text;
  tenant_a text;
  tenant_b text;
  tenant_c text;
  outlet_a text;
  outlet_b text;
  related_id text;
  role_name text;
  system_role boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    immutable_fields := CASE TG_TABLE_NAME
      WHEN 'outlets' THEN ARRAY['tenantId']
      WHEN 'users' THEN ARRAY['tenantId']
      WHEN 'roles' THEN ARRAY['tenantId', 'outletId']
      WHEN 'role_permissions' THEN ARRAY['roleId', 'permissionId']
      WHEN 'user_outlet_roles' THEN ARRAY['userId', 'outletId', 'roleId']
      WHEN 'user_platform_roles' THEN ARRAY['userId', 'roleId']
      WHEN 'outlet_settings' THEN ARRAY['outletId']
      WHEN 'refresh_tokens' THEN ARRAY['userId']
      WHEN 'customers' THEN ARRAY['tenantId']
      WHEN 'customer_outlets' THEN ARRAY['customerId', 'outletId']
      WHEN 'menu_categories' THEN ARRAY['tenantId', 'outletId']
      WHEN 'menu_items' THEN ARRAY['tenantId', 'categoryId']
      WHEN 'outlet_menu_items' THEN ARRAY['outletId', 'menuItemId']
      WHEN 'item_variants' THEN ARRAY['menuItemId']
      WHEN 'item_addons' THEN ARRAY['menuItemId']
      WHEN 'happy_hours' THEN ARRAY['menuItemId']
      WHEN 'restaurant_tables' THEN ARRAY['outletId']
      WHEN 'orders' THEN ARRAY['tenantId', 'outletId']
      WHEN 'order_items' THEN ARRAY['orderId']
      WHEN 'kots' THEN ARRAY['orderId', 'outletId']
      WHEN 'kot_items' THEN ARRAY['kotId', 'orderItemId']
      WHEN 'stations' THEN ARRAY['outletId']
      WHEN 'kot_mutations' THEN ARRAY['outletId', 'userId']
      WHEN 'bills' THEN ARRAY['tenantId', 'outletId', 'orderId']
      WHEN 'payments' THEN ARRAY['billId']
      WHEN 'bill_splits' THEN ARRAY['billId']
      WHEN 'bill_split_items' THEN ARRAY['splitId', 'orderItemId']
      WHEN 'shifts' THEN ARRAY['tenantId', 'outletId', 'userId']
      WHEN 'table_events' THEN ARRAY['orderId']
      WHEN 'loyalty_transactions' THEN ARRAY['customerId']
      WHEN 'feedback' THEN ARRAY['outletId']
      WHEN 'vendors' THEN ARRAY['tenantId']
      WHEN 'coupons' THEN ARRAY['tenantId']
      WHEN 'raw_materials' THEN ARRAY['tenantId', 'outletId']
      WHEN 'recipes' THEN ARRAY['tenantId', 'menuItemId']
      WHEN 'recipe_ingredients' THEN ARRAY['recipeId', 'rawMaterialId']
      WHEN 'purchases' THEN ARRAY['tenantId', 'outletId']
      WHEN 'purchase_lines' THEN ARRAY['purchaseId', 'rawMaterialId']
      WHEN 'stock_movements' THEN ARRAY['outletId', 'rawMaterialId']
      WHEN 'wastage' THEN ARRAY['outletId', 'rawMaterialId']
      WHEN 'sync_queue' THEN ARRAY['tenantId', 'outletId']
      WHEN 'audit_logs' THEN ARRAY['tenantId']
      ELSE ARRAY[]::text[]
    END;

    FOREACH field_name IN ARRAY immutable_fields LOOP
      IF (to_jsonb(NEW) -> field_name) IS DISTINCT FROM (to_jsonb(OLD) -> field_name) THEN
        RAISE EXCEPTION 'KORA ownership fields are immutable on table %', TG_TABLE_NAME
          USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;
    END LOOP;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'roles' THEN
      IF NEW."outletId" IS NOT NULL THEN
        SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
        IF tenant_a IS DISTINCT FROM NEW."tenantId" OR NEW."tenantId" IS NULL THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;
      IF NEW."tenantId" IS NULL AND (NEW."outletId" IS NOT NULL OR NEW."name" IS DISTINCT FROM 'SUPER_ADMIN' OR NEW."isSystem" IS DISTINCT FROM TRUE) THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'user_outlet_roles' THEN
      SELECT "tenantId" INTO tenant_a FROM public.users WHERE id = NEW."userId";
      SELECT "tenantId" INTO tenant_b FROM public.outlets WHERE id = NEW."outletId";
      SELECT "tenantId", "outletId" INTO tenant_c, outlet_a FROM public.roles WHERE id = NEW."roleId";
      IF tenant_a IS DISTINCT FROM tenant_b OR tenant_c IS DISTINCT FROM tenant_b OR (outlet_a IS NOT NULL AND outlet_a IS DISTINCT FROM NEW."outletId") THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'user_platform_roles' THEN
      SELECT "tenantId", "outletId", name, "isSystem" INTO tenant_a, outlet_a, role_name, system_role FROM public.roles WHERE id = NEW."roleId";
      IF tenant_a IS NOT NULL OR outlet_a IS NOT NULL OR role_name IS DISTINCT FROM 'SUPER_ADMIN' OR system_role IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'customer_outlets' THEN
      SELECT "tenantId" INTO tenant_a FROM public.customers WHERE id = NEW."customerId";
      SELECT "tenantId" INTO tenant_b FROM public.outlets WHERE id = NEW."outletId";
      IF tenant_a IS DISTINCT FROM tenant_b THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'menu_categories' THEN
      IF NEW."outletId" IS NOT NULL THEN
        SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
        IF tenant_a IS DISTINCT FROM NEW."tenantId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;
      IF NEW."parentId" IS NOT NULL THEN
        SELECT "tenantId", "outletId" INTO tenant_a, outlet_a FROM public.menu_categories WHERE id = NEW."parentId";
        IF tenant_a IS DISTINCT FROM NEW."tenantId" OR (NEW."outletId" IS NULL AND outlet_a IS NOT NULL) OR (NEW."outletId" IS NOT NULL AND outlet_a IS NOT NULL AND outlet_a IS DISTINCT FROM NEW."outletId") THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;

    WHEN 'menu_items' THEN
      SELECT "tenantId" INTO tenant_a FROM public.menu_categories WHERE id = NEW."categoryId";
      IF tenant_a IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'outlet_menu_items' THEN
      SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
      SELECT "tenantId" INTO tenant_b FROM public.menu_items WHERE id = NEW."menuItemId";
      IF tenant_a IS DISTINCT FROM tenant_b THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;
      IF NEW."stationId" IS NOT NULL THEN
        SELECT "outletId" INTO outlet_a FROM public.stations WHERE id = NEW."stationId";
        IF outlet_a IS DISTINCT FROM NEW."outletId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;

    WHEN 'orders' THEN
      SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
      IF tenant_a IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;
      IF NEW."customerId" IS NOT NULL THEN
        SELECT "tenantId" INTO tenant_b FROM public.customers WHERE id = NEW."customerId";
        IF tenant_b IS DISTINCT FROM NEW."tenantId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;
      IF NEW."tableId" IS NOT NULL THEN
        SELECT "outletId" INTO outlet_a FROM public.restaurant_tables WHERE id = NEW."tableId";
        IF outlet_a IS DISTINCT FROM NEW."outletId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;
      IF NEW."createdById" IS NOT NULL THEN
        SELECT "tenantId" INTO tenant_b FROM public.users WHERE id = NEW."createdById";
        IF tenant_b IS DISTINCT FROM NEW."tenantId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;

    WHEN 'order_items' THEN
      SELECT "tenantId" INTO tenant_a FROM public.orders WHERE id = NEW."orderId";
      IF NEW."menuItemId" IS NOT NULL THEN
        SELECT "tenantId" INTO tenant_b FROM public.menu_items WHERE id = NEW."menuItemId";
        IF tenant_a IS DISTINCT FROM tenant_b THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;

    WHEN 'kots' THEN
      SELECT "tenantId", "outletId" INTO tenant_a, outlet_a FROM public.orders WHERE id = NEW."orderId";
      IF outlet_a IS DISTINCT FROM NEW."outletId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;
      SELECT "tenantId" INTO tenant_b FROM public.outlets WHERE id = NEW."outletId";
      IF tenant_a IS DISTINCT FROM tenant_b THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;
      IF NEW."stationId" IS NOT NULL THEN
        SELECT "outletId" INTO outlet_b FROM public.stations WHERE id = NEW."stationId";
        IF outlet_b IS DISTINCT FROM NEW."outletId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;

    WHEN 'kot_items' THEN
      SELECT "orderId" INTO tenant_a FROM public.kots WHERE id = NEW."kotId";
      SELECT "orderId" INTO tenant_b FROM public.order_items WHERE id = NEW."orderItemId";
      IF tenant_a IS DISTINCT FROM tenant_b THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'kot_mutations' THEN
      SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
      SELECT "tenantId" INTO tenant_b FROM public.users WHERE id = NEW."userId";
      IF tenant_a IS DISTINCT FROM tenant_b THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;
      IF NEW."ticketId" IS NOT NULL THEN
        SELECT "outletId" INTO outlet_a FROM public.kots WHERE id = NEW."ticketId";
        IF outlet_a IS DISTINCT FROM NEW."outletId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;

    WHEN 'bills' THEN
      SELECT "tenantId", "outletId" INTO tenant_a, outlet_a FROM public.orders WHERE id = NEW."orderId";
      IF tenant_a IS DISTINCT FROM NEW."tenantId" OR outlet_a IS DISTINCT FROM NEW."outletId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'payments' THEN
      IF NEW."shiftId" IS NOT NULL THEN
        SELECT "outletId" INTO outlet_a FROM public.shifts WHERE id = NEW."shiftId";
        SELECT b."outletId" INTO outlet_b FROM public.bills b WHERE b.id = NEW."billId";
        IF outlet_a IS DISTINCT FROM outlet_b THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;

    WHEN 'bill_split_items' THEN
      SELECT b."orderId" INTO tenant_a FROM public.bill_splits s JOIN public.bills b ON b.id = s."billId" WHERE s.id = NEW."splitId";
      SELECT "orderId" INTO tenant_b FROM public.order_items WHERE id = NEW."orderItemId";
      IF tenant_a IS DISTINCT FROM tenant_b THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'shifts' THEN
      SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
      SELECT "tenantId" INTO tenant_b FROM public.users WHERE id = NEW."userId";
      IF tenant_a IS DISTINCT FROM NEW."tenantId" OR tenant_b IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'loyalty_transactions' THEN
      SELECT "tenantId" INTO tenant_a FROM public.customers WHERE id = NEW."customerId";
      IF NEW."orderId" IS NOT NULL THEN
        SELECT "tenantId", "customerId" INTO tenant_b, related_id FROM public.orders WHERE id = NEW."orderId";
        IF tenant_a IS DISTINCT FROM tenant_b OR related_id IS DISTINCT FROM NEW."customerId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;

    WHEN 'feedback' THEN
      SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
      IF NEW."customerId" IS NOT NULL THEN
        SELECT "tenantId" INTO tenant_b FROM public.customers WHERE id = NEW."customerId";
        IF tenant_a IS DISTINCT FROM tenant_b THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;
      IF NEW."orderId" IS NOT NULL THEN
        SELECT "outletId", "customerId" INTO outlet_a, related_id FROM public.orders WHERE id = NEW."orderId";
        IF outlet_a IS DISTINCT FROM NEW."outletId" OR (NEW."customerId" IS NOT NULL AND related_id IS DISTINCT FROM NEW."customerId") THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;

    WHEN 'raw_materials' THEN
      SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
      IF tenant_a IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'recipes' THEN
      SELECT "tenantId" INTO tenant_a FROM public.menu_items WHERE id = NEW."menuItemId";
      IF tenant_a IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'recipe_ingredients' THEN
      SELECT "tenantId" INTO tenant_a FROM public.recipes WHERE id = NEW."recipeId";
      SELECT "tenantId" INTO tenant_b FROM public.raw_materials WHERE id = NEW."rawMaterialId";
      IF tenant_a IS DISTINCT FROM tenant_b THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'purchases' THEN
      SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
      IF tenant_a IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;
      IF NEW."vendorId" IS NOT NULL THEN
        SELECT "tenantId" INTO tenant_b FROM public.vendors WHERE id = NEW."vendorId";
        IF tenant_b IS DISTINCT FROM NEW."tenantId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;

    WHEN 'purchase_lines' THEN
      SELECT p."outletId" INTO outlet_a FROM public.purchases p WHERE p.id = NEW."purchaseId";
      SELECT "outletId" INTO outlet_b FROM public.raw_materials WHERE id = NEW."rawMaterialId";
      IF outlet_a IS DISTINCT FROM outlet_b THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'stock_movements' THEN
      SELECT "outletId" INTO outlet_a FROM public.raw_materials WHERE id = NEW."rawMaterialId";
      IF outlet_a IS DISTINCT FROM NEW."outletId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'wastage' THEN
      SELECT "outletId" INTO outlet_a FROM public.raw_materials WHERE id = NEW."rawMaterialId";
      IF outlet_a IS DISTINCT FROM NEW."outletId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'sync_queue' THEN
      SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
      IF tenant_a IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
      END IF;

    WHEN 'audit_logs' THEN
      IF NEW."outletId" IS NOT NULL THEN
        SELECT "tenantId" INTO tenant_a FROM public.outlets WHERE id = NEW."outletId";
        IF tenant_a IS DISTINCT FROM NEW."tenantId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;
      IF NEW."userId" IS NOT NULL THEN
        SELECT "tenantId" INTO tenant_a FROM public.users WHERE id = NEW."userId";
        IF tenant_a IS DISTINCT FROM NEW."tenantId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;
      IF NEW."approvalUserId" IS NOT NULL THEN
        SELECT "tenantId" INTO tenant_a FROM public.users WHERE id = NEW."approvalUserId";
        IF tenant_a IS DISTINCT FROM NEW."tenantId" THEN
          RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
        END IF;
      END IF;
    ELSE
      NULL;
  END CASE;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  guarded_table text;
BEGIN
  FOREACH guarded_table IN ARRAY ARRAY[
    'outlets', 'users', 'roles', 'role_permissions', 'user_outlet_roles',
    'user_platform_roles', 'outlet_settings', 'refresh_tokens', 'customers',
    'customer_outlets', 'menu_categories', 'menu_items', 'outlet_menu_items',
    'item_variants', 'item_addons', 'happy_hours', 'restaurant_tables', 'orders',
    'order_items', 'kots', 'kot_items', 'stations', 'kot_mutations', 'bills',
    'payments', 'bill_splits', 'bill_split_items', 'coupons', 'shifts',
    'table_events', 'loyalty_transactions', 'feedback', 'vendors', 'raw_materials',
    'recipes', 'recipe_ingredients', 'purchases', 'purchase_lines',
    'stock_movements', 'wastage', 'sync_queue', 'audit_logs'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.kora_assert_tenant_ownership()',
      'kora_tenant_guard_' || guarded_table,
      guarded_table
    );
  END LOOP;
END;
$$;
