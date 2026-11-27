ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'SALE_REVERSAL';

-- Sale movements retain the exact BOM inputs needed to reverse unstarted
-- quantities later, even if the recipe is edited or removed after the sale.
ALTER TABLE "stock_movements"
  ADD COLUMN "recipeYieldQuantity" INTEGER,
  ADD COLUMN "recipeIngredientQuantityMilli" BIGINT,
  ADD COLUMN "recipeQuantityBefore" BIGINT;

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_recipe_snapshot_check"
  CHECK (
    ("recipeYieldQuantity" IS NULL AND "recipeIngredientQuantityMilli" IS NULL AND "recipeQuantityBefore" IS NULL)
    OR
    ("recipeYieldQuantity" IS NOT NULL AND "recipeIngredientQuantityMilli" IS NOT NULL AND "recipeQuantityBefore" IS NOT NULL
      AND "recipeYieldQuantity" > 0 AND "recipeIngredientQuantityMilli" > 0 AND "recipeQuantityBefore" >= 0)
  );

-- Existing outlets fail closed: stock-short sales remain blocked until an owner
-- explicitly changes the per-outlet policy to ALLOW_NEGATIVE.
UPDATE "outlet_settings"
SET "settings" = jsonb_set(
  CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END,
  '{stockShortagePolicy}',
  '"BLOCK"'::jsonb,
  true
)
WHERE COALESCE("settings"->>'stockShortagePolicy', '') NOT IN ('BLOCK', 'ALLOW_NEGATIVE');

-- Down migration (manual/reversible): drop the recipe snapshot check/columns,
-- remove the stockShortagePolicy JSON key if desired, and rebuild
-- StockMovementType without SALE_REVERSAL after confirming no rows use it;
-- PostgreSQL enum labels cannot be dropped directly.
