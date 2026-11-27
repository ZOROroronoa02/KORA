import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeDeductionsByOrderItem, recipeDeductionsForSale } from '../src/lib/domain/recipe-consumption.ts';

test('recipe deductions aggregate repeated lines and scale by recipe yield without under-deducting', () => {
  const result = recipeDeductionsForSale(
    [{ menuItemId: 'dosa', quantity: 1 }, { menuItemId: 'dosa', quantity: 2 }, { menuItemId: 'tea', quantity: 1 }],
    [
      { menuItemId: 'dosa', yieldQuantity: 2, ingredients: [{ rawMaterialId: 'batter', quantityMilli: '1500' }, { rawMaterialId: 'oil', quantityMilli: 25n }] },
      { menuItemId: 'tea', yieldQuantity: 3, ingredients: [{ rawMaterialId: 'milk', quantityMilli: 1n }] },
    ],
  );
  assert.deepEqual(result, [
    { rawMaterialId: 'batter', quantityMilli: 2250n },
    { rawMaterialId: 'milk', quantityMilli: 1n },
    { rawMaterialId: 'oil', quantityMilli: 38n },
  ]);
});

test('unmapped items do not alter stock and identical materials aggregate across recipes', () => {
  const result = recipeDeductionsForSale(
    [{ menuItemId: 'meal', quantity: 2 }, { menuItemId: 'side', quantity: 3 }, { menuItemId: 'unmapped', quantity: 99 }],
    [
      { menuItemId: 'meal', yieldQuantity: 1, ingredients: [{ rawMaterialId: 'rice', quantityMilli: 10n }] },
      { menuItemId: 'side', yieldQuantity: 3, ingredients: [{ rawMaterialId: 'rice', quantityMilli: 2n }] },
    ],
  );
  assert.deepEqual(result, [{ rawMaterialId: 'rice', quantityMilli: 22n }]);
});

test('recipe deductions reject invalid sale and recipe amounts', () => {
  assert.throws(() => recipeDeductionsForSale([{ menuItemId: 'a', quantity: 0 }], []), /positive safe quantities/);
  assert.throws(() => recipeDeductionsForSale([{ menuItemId: 'a', quantity: 1 }], [{ menuItemId: 'a', yieldQuantity: 0, ingredients: [] }]), /yield or menu-item/);
  assert.throws(() => recipeDeductionsForSale([{ menuItemId: 'a', quantity: 1 }], [{ menuItemId: 'a', yieldQuantity: 1, ingredients: [{ rawMaterialId: 'r', quantityMilli: '-1' }] }]), /positive integer/);
});

test('sale rounding is allocated across order items without duplicating sub-unit stock', () => {
  const deductions = recipeDeductionsByOrderItem(
    [{ orderItemId: 'line-a', menuItemId: 'sauce', quantity: 1 }, { orderItemId: 'line-b', menuItemId: 'sauce', quantity: 1 }],
    [{ menuItemId: 'sauce', yieldQuantity: 3, ingredients: [{ rawMaterialId: 'spice', quantityMilli: 1n }] }],
  );
  assert.deepEqual(deductions, [{
    orderItemId: 'line-a', rawMaterialId: 'spice', quantityMilli: 1n,
    recipeYieldQuantity: 3, recipeIngredientQuantityMilli: 1n, recipeQuantityBefore: 0n,
  }]);
  assert.throws(() => recipeDeductionsByOrderItem([{ orderItemId: 'same', menuItemId: 'a', quantity: 1 }, { orderItemId: 'same', menuItemId: 'b', quantity: 1 }], []), /unique order items/);
});

test('recipe sale snapshots retain the cumulative rounding offset for each order item', () => {
  const deductions = recipeDeductionsByOrderItem(
    [{ orderItemId: 'line-b', menuItemId: 'sauce', quantity: 1 }, { orderItemId: 'line-a', menuItemId: 'sauce', quantity: 1 }],
    [{ menuItemId: 'sauce', yieldQuantity: 3, ingredients: [{ rawMaterialId: 'spice', quantityMilli: 2n }] }],
  );
  assert.deepEqual(deductions, [
    { orderItemId: 'line-a', rawMaterialId: 'spice', quantityMilli: 1n, recipeYieldQuantity: 3, recipeIngredientQuantityMilli: 2n, recipeQuantityBefore: 0n },
    { orderItemId: 'line-b', rawMaterialId: 'spice', quantityMilli: 1n, recipeYieldQuantity: 3, recipeIngredientQuantityMilli: 2n, recipeQuantityBefore: 1n },
  ]);
});
