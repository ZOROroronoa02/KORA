-- Keep recipes attached to the exact outlet/menu availability row. Removing an
-- outlet menu assignment removes only that outlet's recipe and BOM.
ALTER TABLE "recipes"
  ADD CONSTRAINT "recipes_outletId_menuItemId_fkey"
  FOREIGN KEY ("outletId", "menuItemId")
  REFERENCES "outlet_menu_items"("outletId", "menuItemId")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION kora_recipe_outlet_ownership_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  outlet_tenant TEXT;
  menu_tenant TEXT;
BEGIN
  SELECT "tenantId" INTO outlet_tenant FROM public.outlets WHERE id = NEW."outletId";
  SELECT "tenantId" INTO menu_tenant FROM public.menu_items WHERE id = NEW."menuItemId";
  IF outlet_tenant IS DISTINCT FROM NEW."tenantId" OR menu_tenant IS DISTINCT FROM NEW."tenantId"
     OR NOT EXISTS (SELECT 1 FROM public.outlet_menu_items WHERE "outletId" = NEW."outletId" AND "menuItemId" = NEW."menuItemId")
     OR EXISTS (
       SELECT 1
       FROM public.recipe_ingredients ri
       JOIN public.raw_materials m ON m.id = ri."rawMaterialId"
       WHERE ri."recipeId" = NEW.id AND m."outletId" IS DISTINCT FROM NEW."outletId"
     ) THEN
    RAISE EXCEPTION 'KORA recipe tenant/outlet ownership violation' USING ERRCODE = '23514', CONSTRAINT = 'kora_recipe_outlet_ownership_guard';
  END IF;
  RETURN NEW;
END;
$$;

-- Down migration (manual/reversible): drop the ownership function replacement
-- by restoring the prior function body, then drop recipes_outletId_menuItemId_fkey.
