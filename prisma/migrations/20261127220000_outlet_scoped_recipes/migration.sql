-- Recipe BOMs must belong to one outlet because their raw-material stocks are
-- outlet-scoped. Preserve a legacy recipe only when its outlet can be inferred
-- without ambiguity; otherwise fail before changing the existing recipe rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT r.id
    FROM "recipes" r
    JOIN "recipe_ingredients" ri ON ri."recipeId" = r.id
    JOIN "raw_materials" m ON m.id = ri."rawMaterialId"
    GROUP BY r.id
    HAVING COUNT(DISTINCT m."outletId") > 1
  ) THEN
    RAISE EXCEPTION 'Cannot scope a recipe whose ingredients come from multiple outlets';
  END IF;
END $$;

ALTER TABLE "recipes" ADD COLUMN "outletId" TEXT;

UPDATE "recipes" r
SET "outletId" = COALESCE(
  (
    SELECT MIN(m."outletId")
    FROM "recipe_ingredients" ri
    JOIN "raw_materials" m ON m.id = ri."rawMaterialId"
    WHERE ri."recipeId" = r.id
    HAVING COUNT(DISTINCT m."outletId") = 1
  ),
  (
    SELECT MIN(omi."outletId")
    FROM "outlet_menu_items" omi
    WHERE omi."menuItemId" = r."menuItemId"
    HAVING COUNT(DISTINCT omi."outletId") = 1
  )
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "recipes" r
    LEFT JOIN "outlets" o ON o.id = r."outletId" AND o."tenantId" = r."tenantId"
    LEFT JOIN "menu_items" mi ON mi.id = r."menuItemId" AND mi."tenantId" = r."tenantId"
    LEFT JOIN "outlet_menu_items" omi ON omi."outletId" = r."outletId" AND omi."menuItemId" = r."menuItemId"
    WHERE r."outletId" IS NULL OR o.id IS NULL OR mi.id IS NULL OR omi."menuItemId" IS NULL OR r."yieldQuantity" < 1
  ) THEN
    RAISE EXCEPTION 'Cannot safely scope existing recipe data; resolve recipe outlet, menu ownership, availability, and yield first';
  END IF;

  IF EXISTS (SELECT 1 FROM "recipe_ingredients" WHERE "quantityMilli" <= 0) THEN
    RAISE EXCEPTION 'Cannot migrate recipe ingredients with non-positive quantities';
  END IF;
END $$;

ALTER TABLE "recipes" ALTER COLUMN "outletId" SET NOT NULL;
DROP INDEX "recipes_menuItemId_key";
CREATE UNIQUE INDEX "recipes_outletId_menuItemId_key" ON "recipes"("outletId", "menuItemId");
CREATE INDEX "recipes_tenantId_outletId_idx" ON "recipes"("tenantId", "outletId");
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_yieldQuantity_check" CHECK ("yieldQuantity" > 0);
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_quantity_check" CHECK ("quantityMilli" > 0);
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"(id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION kora_recipe_outlet_ownership_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  outlet_tenant TEXT;
  menu_tenant TEXT;
BEGIN
  SELECT "tenantId" INTO outlet_tenant FROM public.outlets WHERE id = NEW."outletId";
  SELECT "tenantId" INTO menu_tenant FROM public.menu_items WHERE id = NEW."menuItemId";
  IF outlet_tenant IS DISTINCT FROM NEW."tenantId" OR menu_tenant IS DISTINCT FROM NEW."tenantId"
     OR NOT EXISTS (SELECT 1 FROM public.outlet_menu_items WHERE "outletId" = NEW."outletId" AND "menuItemId" = NEW."menuItemId") THEN
    RAISE EXCEPTION 'KORA recipe tenant/outlet ownership violation' USING ERRCODE = '23514', CONSTRAINT = 'kora_recipe_outlet_ownership_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION kora_recipe_ingredient_outlet_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  recipe_outlet TEXT;
  material_outlet TEXT;
BEGIN
  SELECT "outletId" INTO recipe_outlet FROM public.recipes WHERE id = NEW."recipeId";
  SELECT "outletId" INTO material_outlet FROM public.raw_materials WHERE id = NEW."rawMaterialId";
  IF recipe_outlet IS DISTINCT FROM material_outlet THEN
    RAISE EXCEPTION 'KORA recipe ingredient outlet ownership violation' USING ERRCODE = '23514', CONSTRAINT = 'kora_recipe_ingredient_outlet_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kora_recipe_outlet_ownership_guard
BEFORE INSERT OR UPDATE ON public.recipes
FOR EACH ROW EXECUTE FUNCTION kora_recipe_outlet_ownership_guard();

CREATE TRIGGER kora_recipe_ingredient_outlet_guard
BEFORE INSERT OR UPDATE ON public.recipe_ingredients
FOR EACH ROW EXECUTE FUNCTION kora_recipe_ingredient_outlet_guard();

-- Down migration (manual/reversible): first ensure there is no duplicate
-- menuItemId across outlets; drop the two triggers/functions and outlet FK,
-- checks, and indexes; restore recipes_menuItemId_key; drop recipes.outletId.
-- Cross-outlet recipes cannot be represented by the old schema.
