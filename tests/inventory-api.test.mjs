import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { PrismaClient } from '@prisma/client';
import { accessTokenSigningKey } from '../src/lib/jwt-secret.ts';

const api = process.env.KORA_SECURITY_TEST_URL;
const enabled = Boolean(api && process.env.DATABASE_URL && process.env.JWT_ACCESS_SECRET);

test('inventory API enforces outlet permissions and atomically audits stock corrections and wastage', { skip: !enabled, timeout: 60000 }, async () => {
  const prisma = new PrismaClient();
  let tenantId;
  let foreignTenantId;
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const tenant = await prisma.tenant.create({ data: { name: `Inventory ${suffix}`, slug: `inventory-${suffix}` } });
    tenantId = tenant.id;
    const outlet = await prisma.outlet.create({ data: { tenantId, name: 'Main outlet', code: `I-${suffix}` } });
    const user = await prisma.user.create({ data: { tenantId, name: 'Inventory owner', email: `inventory-owner-${suffix}@example.test`, passwordHash: 'unused-test-password-hash' } });
    const roleFor = async (name, keys) => {
      const permissions = await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
      assert.equal(permissions.length, keys.length, 'required inventory permissions must be seeded');
      return prisma.role.create({ data: { tenantId, name: `${name}_${suffix}`, description: 'API integration test role', permissions: { create: permissions.map(({ id }) => ({ permissionId: id })) } } });
    };
    const ownerRole = await roleFor('INVENTORY_OWNER', ['inventory.view', 'inventory.adjust']);
    await prisma.userOutletRole.create({ data: { userId: user.id, outletId: outlet.id, roleId: ownerRole.id } });
    const tokenFor = (userId) => new SignJWT({ tenantId })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime('5m')
      .sign(accessTokenSigningKey(process.env.JWT_ACCESS_SECRET));
    const ownerHeaders = { authorization: `Bearer ${await tokenFor(user.id)}`, 'content-type': 'application/json' };
    const material = await prisma.rawMaterial.create({ data: { tenantId, outletId: outlet.id, name: `Rice ${suffix}`, unit: 'kg', quantityMilli: 2500n, reorderMilli: 1000n, costPerUnitPaise: 8000n } });
    const category = await prisma.menuCategory.create({ data: { tenantId, outletId: outlet.id, name: `Recipes ${suffix}` } });
    const menuItem = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Rice bowl ${suffix}`, basePricePaise: 10000n, outletPrices: { create: { outletId: outlet.id } } } });
    const recipeBody = { operation: 'create', outletId: outlet.id, menuItemId: menuItem.id, yieldQuantity: 2, ingredients: [{ rawMaterialId: material.id, quantityMilli: '1500' }] };
    const recipeResponse = await fetch(`${api}/api/inventory/recipes`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(recipeBody) });
    const recipeResult = await recipeResponse.json();
    assert.equal(recipeResponse.status, 201, JSON.stringify(recipeResult));
    assert.equal(recipeResult.recipe.outletId, outlet.id);
    assert.equal(recipeResult.recipe.ingredients[0].quantityMilli, '1500');
    const duplicateRecipeResponse = await fetch(`${api}/api/inventory/recipes`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(recipeBody) });
    assert.equal(duplicateRecipeResponse.status, 409, 'a stale create form must never overwrite an existing BOM');
    const recipesReadResponse = await fetch(`${api}/api/inventory/recipes?outletId=${outlet.id}`, { headers: ownerHeaders });
    const recipesRead = await recipesReadResponse.json();
    assert.equal(recipesReadResponse.status, 200);
    assert.equal(recipesRead.recipes.length, 1);
    assert.equal(recipesRead.recipes[0].menuItem.name, menuItem.name);
    assert.equal(recipesRead.menuItems.some(({ id }) => id === menuItem.id), true, 'recipe editor choices must only contain menu items sold at this outlet');
    const recipeUpdateResponse = await fetch(`${api}/api/inventory/recipes`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ ...recipeBody, operation: 'update', yieldQuantity: 3, ingredients: [{ rawMaterialId: material.id, quantityMilli: '2000' }] }) });
    assert.equal(recipeUpdateResponse.status, 200);
    const recipeAudit = await prisma.auditLog.findFirst({ where: { tenantId, outletId: outlet.id, action: 'RECIPE_UPDATED', entityType: 'Recipe', entityId: recipeResult.recipe.id } });
    assert.equal(recipeAudit?.before?.ingredients[0]?.quantityMilli, '1500');

    const vendorCreateBody = { outletId: outlet.id, name: `Produce ${suffix}`, phone: '+91 98765 43210', email: `vendor-${suffix}@example.test`, gstin: '29ABCDE1234F1Z5' };
    const vendorCreateResponse = await fetch(`${api}/api/inventory/vendors`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(vendorCreateBody) });
    const vendorCreated = await vendorCreateResponse.json();
    assert.equal(vendorCreateResponse.status, 201, JSON.stringify(vendorCreated));
    assert.equal(vendorCreated.vendor.phone, '+919876543210');
    const vendorCreatedAudit = await prisma.auditLog.findFirst({ where: { tenantId, outletId: outlet.id, action: 'VENDOR_CREATED', entityId: vendorCreated.vendor.id } });
    assert.equal(vendorCreatedAudit?.after?.name, vendorCreateBody.name);
    const invalidVendor = await fetch(`${api}/api/inventory/vendors`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ ...vendorCreateBody, name: 'Invalid GST vendor', gstin: 'not-valid' }) });
    assert.equal(invalidVendor.status, 400);
    const vendorUpdatedResponse = await fetch(`${api}/api/inventory/vendors`, { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ outletId: outlet.id, vendorId: vendorCreated.vendor.id, active: false }) });
    const vendorUpdated = await vendorUpdatedResponse.json();
    assert.equal(vendorUpdatedResponse.status, 200, JSON.stringify(vendorUpdated));
    assert.equal(vendorUpdated.vendor.active, false);
    const vendorReadResponse = await fetch(`${api}/api/inventory/vendors?outletId=${outlet.id}`, { headers: ownerHeaders });
    const vendorRead = await vendorReadResponse.json();
    assert.equal(vendorReadResponse.status, 200);
    assert.equal(vendorRead.items.find(({ id }) => id === vendorCreated.vendor.id)?.active, false);
    const invalidCursor = await fetch(`${api}/api/inventory/vendors?outletId=${outlet.id}&cursor=unknown-vendor`, { headers: ownerHeaders });
    assert.equal(invalidCursor.status, 400);

    const createBody = { outletId: outlet.id, operation: 'create', name: `Cardamom ${suffix}`, unit: 'g', reorderMilli: '1500', costPerUnitPaise: '12000' };
    const createdResponse = await fetch(`${api}/api/inventory`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(createBody) });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201, JSON.stringify(created));
    assert.equal(created.material.quantityMilli, '0');
    assert.equal(created.material.reorderMilli, '1500');
    const duplicateIngredient = await fetch(`${api}/api/inventory`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(createBody) });
    assert.equal(duplicateIngredient.status, 409, 'duplicate ingredient names must not create ambiguous stock records');
    const createdAudit = await prisma.auditLog.findFirst({ where: { tenantId, outletId: outlet.id, action: 'STOCK_MATERIAL_CREATED', entityId: created.material.id } });
    assert.equal(createdAudit?.after?.name, createBody.name);

    const update = (payload, headers = ownerHeaders, targetOutletId = outlet.id) => fetch(`${api}/api/inventory`, { method: 'POST', headers, body: JSON.stringify({ outletId: targetOutletId, rawMaterialId: material.id, ...payload }) });
    const unauthorizedOutlet = await fetch(`${api}/api/inventory?outletId=missing-outlet`, { headers: ownerHeaders });
    assert.equal(unauthorizedOutlet.status, 403);
    const siblingOutlet = await prisma.outlet.create({ data: { tenantId, name: 'Unassigned outlet', code: `UI-${suffix}` } });
    const siblingAttempt = await fetch(`${api}/api/inventory`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ outletId: siblingOutlet.id, rawMaterialId: material.id, operation: 'adjust', quantityMilli: '1000', reason: 'Cross-outlet attempt' }),
    });
    assert.equal(siblingAttempt.status, 403, 'an owner assignment to one outlet must not authorize another outlet');
    const siblingUser = await prisma.user.create({ data: { tenantId, name: 'Sibling inventory owner', email: `sibling-owner-${suffix}@example.test`, passwordHash: 'unused-test-password-hash' } });
    await prisma.userOutletRole.create({ data: { userId: siblingUser.id, outletId: siblingOutlet.id, roleId: ownerRole.id } });
    const siblingHeaders = { authorization: `Bearer ${await tokenFor(siblingUser.id)}`, 'content-type': 'application/json' };
    const siblingCategory = await prisma.menuCategory.create({ data: { tenantId, outletId: siblingOutlet.id, name: `Sibling recipes ${suffix}` } });
    const siblingMenuItem = await prisma.menuItem.create({ data: { tenantId, categoryId: siblingCategory.id, name: `Sibling bowl ${suffix}`, basePricePaise: 10000n, outletPrices: { create: { outletId: siblingOutlet.id } } } });
    const foreignMenuCursor = await fetch(`${api}/api/inventory/recipes?outletId=${outlet.id}&menuCursor=${siblingMenuItem.id}`, { headers: ownerHeaders });
    assert.equal(foreignMenuCursor.status, 400, 'menu pagination must reject cursors from other outlets');
    const crossOutletRecipe = await fetch(`${api}/api/inventory/recipes`, {
      method: 'POST', headers: siblingHeaders,
      body: JSON.stringify({ operation: 'create', outletId: siblingOutlet.id, menuItemId: siblingMenuItem.id, yieldQuantity: 1, ingredients: [{ rawMaterialId: material.id, quantityMilli: '100' }] }),
    });
    assert.equal(crossOutletRecipe.status, 404, 'recipe ingredients must be in the same outlet as the recipe');
    const assertRecipeOutletOwnershipRejection = (error) => {
      const details = JSON.stringify({ code: error.code, meta: error.meta, message: error.message });
      assert.match(details, /KORA recipe ingredient outlet ownership violation/i);
      return true;
    };
    await assert.rejects(prisma.recipe.create({ data: {
      tenantId, outletId: siblingOutlet.id, menuItemId: siblingMenuItem.id, yieldQuantity: 1,
      ingredients: { create: [{ rawMaterialId: material.id, quantityMilli: 100n }] },
    } }), assertRecipeOutletOwnershipRejection, 'database guard must block cross-outlet recipe BOMs');
    const movableMenuItem = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Movable bowl ${suffix}`, basePricePaise: 10000n, outletPrices: { create: { outletId: outlet.id } } } });
    const movableRecipe = await prisma.recipe.create({ data: { tenantId, outletId: outlet.id, menuItemId: movableMenuItem.id, yieldQuantity: 1, ingredients: { create: [{ rawMaterialId: material.id, quantityMilli: 100n }] } } });
    await assert.rejects(prisma.outletMenuItem.update({
      where: { outletId_menuItemId: { outletId: outlet.id, menuItemId: movableMenuItem.id } },
      data: { outletId: siblingOutlet.id },
    }), (error) => /KORA ownership fields are immutable on table outlet_menu_items/i.test(JSON.stringify({ message: error.message, meta: error.meta })), 'moving a menu assignment is blocked before it can strand an outlet recipe');
    const removableMenuItem = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Removable bowl ${suffix}`, basePricePaise: 10000n, outletPrices: { create: { outletId: outlet.id } } } });
    await prisma.recipe.create({ data: { tenantId, outletId: outlet.id, menuItemId: removableMenuItem.id, yieldQuantity: 1, ingredients: { create: [{ rawMaterialId: material.id, quantityMilli: 100n }] } } });
    await prisma.outletMenuItem.delete({ where: { outletId_menuItemId: { outletId: outlet.id, menuItemId: removableMenuItem.id } } });
    assert.equal(await prisma.recipe.count({ where: { tenantId, outletId: outlet.id, menuItemId: removableMenuItem.id } }), 0, 'removing outlet menu availability cascades only the attached recipe');
    assert.equal(await prisma.recipe.count({ where: { id: movableRecipe.id } }), 1, 'a rejected menu move leaves the original outlet recipe intact');

    const correctionResponse = await update({ operation: 'adjust', quantityMilli: '1000', reason: 'Verified physical count' });
    const correction = await correctionResponse.json();
    assert.equal(correctionResponse.status, 201, JSON.stringify(correction));
    assert.equal(correction.material.quantityMilli, '3500');
    assert.equal(correction.movement.quantityMilli, '1000');

    const wastageResponse = await update({ operation: 'wastage', quantityMilli: '500', reason: 'Spoiled during storage' });
    const wastage = await wastageResponse.json();
    assert.equal(wastageResponse.status, 201, JSON.stringify(wastage));
    assert.equal(wastage.material.quantityMilli, '3000');
    assert.equal(wastage.movement.quantityMilli, '-500');
    assert.equal(await prisma.wastage.count({ where: { outletId: outlet.id, rawMaterialId: material.id, quantityMilli: 500n } }), 1);

    const beforeRejected = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: material.id } });
    const overspend = await update({ operation: 'adjust', quantityMilli: '-4000', reason: 'Incorrect count correction' });
    assert.equal(overspend.status, 409);
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: material.id } })).quantityMilli, beforeRejected.quantityMilli, 'rejected stock removal must not change the balance');

    const missingReason = await update({ operation: 'adjust', quantityMilli: '1', reason: '  ' });
    assert.equal(missingReason.status, 400);
    const unsupportedPurchase = await update({ operation: 'purchase', quantityMilli: '500', reason: 'Supplier delivery' });
    assert.equal(unsupportedPurchase.status, 400, 'stock increments must not masquerade as recorded vendor purchases');

    const racingRemovals = await Promise.all([
      update({ operation: 'adjust', quantityMilli: '-2000', reason: 'Count correction A' }),
      update({ operation: 'adjust', quantityMilli: '-2000', reason: 'Count correction B' }),
    ]);
    assert.equal(racingRemovals.filter((response) => response.status === 201).length, 1, 'only one concurrent removal may consume the remaining balance');
    assert.equal(racingRemovals.filter((response) => response.status === 409).length, 1);
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: material.id } })).quantityMilli, 1000n);

    const viewer = await prisma.user.create({ data: { tenantId, name: 'Inventory viewer', email: `inventory-viewer-${suffix}@example.test`, passwordHash: 'unused-test-password-hash' } });
    const viewerRole = await roleFor('INVENTORY_VIEWER', ['inventory.view']);
    await prisma.userOutletRole.create({ data: { userId: viewer.id, outletId: outlet.id, roleId: viewerRole.id } });
    const viewerHeaders = { authorization: `Bearer ${await tokenFor(viewer.id)}`, 'content-type': 'application/json' };
    const viewerRecipeUpdate = await fetch(`${api}/api/inventory/recipes`, { method: 'POST', headers: viewerHeaders, body: JSON.stringify(recipeBody) });
    assert.equal(viewerRecipeUpdate.status, 403, 'inventory viewers cannot change recipes');
    const viewerUpdate = await update({ operation: 'adjust', quantityMilli: '1000', reason: 'Attempted unauthorized change' }, viewerHeaders);
    assert.equal(viewerUpdate.status, 403);
    const viewerVendorUpdate = await fetch(`${api}/api/inventory/vendors`, { method: 'PATCH', headers: viewerHeaders, body: JSON.stringify({ outletId: outlet.id, vendorId: vendorCreated.vendor.id, active: true }) });
    assert.equal(viewerVendorUpdate.status, 403);

    foreignTenantId = (await prisma.tenant.create({ data: { name: `Foreign Inventory ${suffix}`, slug: `foreign-inventory-${suffix}` } })).id;
    const foreignOutlet = await prisma.outlet.create({ data: { tenantId: foreignTenantId, name: 'Foreign outlet', code: `FI-${suffix}` } });
    const crossTenantRead = await fetch(`${api}/api/inventory?outletId=${foreignOutlet.id}`, { headers: ownerHeaders });
    assert.equal(crossTenantRead.status, 403);
    const crossTenantVendorRead = await fetch(`${api}/api/inventory/vendors?outletId=${foreignOutlet.id}`, { headers: ownerHeaders });
    assert.equal(crossTenantVendorRead.status, 403);

    const [correctionAudit, wastageAudit] = await Promise.all([
      prisma.auditLog.findFirst({ where: { tenantId, outletId: outlet.id, action: 'STOCK_ADJUST', entityId: material.id, reason: 'Verified physical count' } }),
      prisma.auditLog.findFirst({ where: { tenantId, outletId: outlet.id, action: 'STOCK_WASTAGE', entityId: material.id, reason: 'Spoiled during storage' } }),
    ]);
    assert.equal(correctionAudit?.before?.quantityMilli, '2500');
    assert.equal(correctionAudit?.after?.quantityMilli, '3500');
    assert.equal(wastageAudit?.before?.quantityMilli, '3500');
    assert.equal(wastageAudit?.after?.quantityMilli, '3000');
    const recipeDeleteResponse = await fetch(`${api}/api/inventory/recipes?outletId=${outlet.id}&menuItemId=${menuItem.id}`, { method: 'DELETE', headers: ownerHeaders });
    assert.equal(recipeDeleteResponse.status, 200);
    const vendorAudit = await prisma.auditLog.findFirst({ where: { tenantId, outletId: outlet.id, action: 'VENDOR_UPDATED', entityId: vendorCreated.vendor.id } });
    assert.equal(vendorAudit?.before?.active, true);
    assert.equal(vendorAudit?.after?.active, false);
  } finally {
    if (foreignTenantId) await prisma.tenant.deleteMany({ where: { id: foreignTenantId } }).catch(() => undefined);
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
