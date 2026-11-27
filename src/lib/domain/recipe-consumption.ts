const MAX_STOCK_QUANTITY = 9_223_372_036_854_775_807n;

export type SoldMenuLine = { menuItemId: string; quantity: number };
export type SoldOrderItemLine = SoldMenuLine & { orderItemId: string };
export type RecipeBOM = {
  menuItemId: string;
  yieldQuantity: number;
  ingredients: Array<{ rawMaterialId: string; quantityMilli: bigint | string }>;
};

export type OrderItemRecipeDeduction = {
  orderItemId: string;
  rawMaterialId: string;
  quantityMilli: bigint;
  recipeYieldQuantity: number;
  recipeIngredientQuantityMilli: bigint;
  recipeQuantityBefore: bigint;
};

/** Allocate rounded recipe usage to order lines without exceeding whole-sale consumption. */
export function recipeDeductionsByOrderItem(lines: SoldOrderItemLine[], recipes: RecipeBOM[]) {
  const soldByMenuItem = new Map<string, SoldOrderItemLine[]>();
  const orderItemIds = new Set<string>();
  for (const line of lines) {
    if (!line.orderItemId || orderItemIds.has(line.orderItemId) || !line.menuItemId || !Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new RangeError("Recipe sale lines need unique order items and positive safe quantities.");
    orderItemIds.add(line.orderItemId);
    const group = soldByMenuItem.get(line.menuItemId) ?? [];
    group.push(line);
    soldByMenuItem.set(line.menuItemId, group);
  }

  const recipeByMenuItem = new Map<string, RecipeBOM>();
  for (const recipe of recipes) {
    if (!recipe.menuItemId || !Number.isSafeInteger(recipe.yieldQuantity) || recipe.yieldQuantity < 1 || recipeByMenuItem.has(recipe.menuItemId)) {
      throw new RangeError("Recipe yield or menu-item mapping is invalid.");
    }
    recipeByMenuItem.set(recipe.menuItemId, recipe);
  }

  const allocations = new Map<string, Map<string, Omit<OrderItemRecipeDeduction, "orderItemId" | "rawMaterialId">>>();
  for (const [menuItemId, menuLines] of soldByMenuItem) {
    const recipe = recipeByMenuItem.get(menuItemId);
    if (!recipe) continue;
    const yieldQuantity = BigInt(recipe.yieldQuantity);
    for (const ingredient of recipe.ingredients) {
      const amount = typeof ingredient.quantityMilli === "bigint" ? ingredient.quantityMilli : /^\d{1,19}$/.test(ingredient.quantityMilli) ? BigInt(ingredient.quantityMilli) : -1n;
      if (!ingredient.rawMaterialId || amount <= 0n) throw new RangeError("Recipe ingredient quantities must be positive integer milli-units.");
      let cumulativeQuantity = 0n;
      let cumulativeDeduction = 0n;
      for (const line of [...menuLines].sort((left, right) => left.orderItemId.localeCompare(right.orderItemId))) {
        const quantityBefore = cumulativeQuantity;
        cumulativeQuantity += BigInt(line.quantity);
        const nextCumulativeDeduction = (amount * cumulativeQuantity + yieldQuantity - 1n) / yieldQuantity;
        const deduction = nextCumulativeDeduction - cumulativeDeduction;
        cumulativeDeduction = nextCumulativeDeduction;
        if (deduction === 0n) continue;
        const row = allocations.get(line.orderItemId) ?? new Map<string, Omit<OrderItemRecipeDeduction, "orderItemId" | "rawMaterialId">>();
        const previous = row.get(ingredient.rawMaterialId);
        const total = (previous?.quantityMilli ?? 0n) + deduction;
        if (total > MAX_STOCK_QUANTITY) throw new RangeError("Recipe stock deduction exceeds the supported quantity range.");
        row.set(ingredient.rawMaterialId, {
          quantityMilli: total,
          recipeYieldQuantity: recipe.yieldQuantity,
          recipeIngredientQuantityMilli: amount,
          recipeQuantityBefore: previous?.recipeQuantityBefore ?? quantityBefore,
        });
        allocations.set(line.orderItemId, row);
      }
    }
  }
  return [...allocations.entries()].sort(([left], [right]) => left.localeCompare(right)).flatMap(([orderItemId, row]) =>
    [...row.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([rawMaterialId, recipe]) => ({
      orderItemId,
      rawMaterialId,
      ...recipe,
    })),
  );
}

/** Aggregate recipe usage into deterministic per-ingredient milli-unit deductions. */
export function recipeDeductionsForSale(lines: SoldMenuLine[], recipes: RecipeBOM[]) {
  const byLine = recipeDeductionsByOrderItem(lines.map((line, index) => ({ ...line, orderItemId: `line-${index}` })), recipes);
  const totals = new Map<string, bigint>();
  for (const deduction of byLine) {
    const total = (totals.get(deduction.rawMaterialId) ?? 0n) + deduction.quantityMilli;
    if (total > MAX_STOCK_QUANTITY) throw new RangeError("Recipe stock deduction exceeds the supported quantity range.");
    totals.set(deduction.rawMaterialId, total);
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([rawMaterialId, quantityMilli]) => ({ rawMaterialId, quantityMilli }));
}
