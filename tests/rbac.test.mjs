import test from 'node:test';
import assert from 'node:assert/strict';
import { can, permissionsForRoles, systemRolePermissions } from '../src/lib/permissions.ts';
import { realtimeEventPermissions, realtimeRoomsForEvent } from '../src/lib/realtime-permissions.ts';

test('system role defaults match the restaurant access boundaries', () => {
  const owner = new Set(systemRolePermissions.OWNER);
  assert.equal(owner.has('orders.create'), false);
  assert.equal(owner.has('roles.manage'), true);
  assert.equal(owner.has('bills.day_close'), true);

  const manager = new Set(systemRolePermissions.RESTAURANT_MANAGER);
  assert.equal(manager.has('orders.create'), true);
  assert.equal(manager.has('inventory.adjust'), true);
  assert.equal(manager.has('staff.manage'), true);
  assert.equal(manager.has('roles.manage'), false);
  assert.equal(manager.has('outlets.manage'), false);

  const cashier = new Set(systemRolePermissions.CASHIER);
  assert.equal(cashier.has('bills.discount.apply'), true);
  assert.equal(cashier.has('bills.discount.approve'), false);
  assert.equal(cashier.has('bills.settle'), true);
  assert.equal(cashier.has('orders.void'), false);

  const waiter = new Set(systemRolePermissions.WAITER);
  assert.equal(waiter.has('orders.create'), true);
  assert.equal(waiter.has('orders.move_table'), true);
  assert.equal([...waiter].some((permission) => permission.startsWith('bills.')), false);
  assert.deepEqual(systemRolePermissions.CHEF, ['kds.view', 'kds.bump', 'kds.recall', 'kds.hold']);
  assert.equal(systemRolePermissions.ACCOUNTANT.includes('audit.view'), true);
  assert.equal(systemRolePermissions.INVENTORY_MANAGER.includes('inventory.adjust'), true);
});

test('permission evaluation is exact and role permission unions are stable', () => {
  assert.equal(can({ permissions: ['reports.view.sales'] }, 'reports.view.sales'), true);
  assert.equal(can({ permissions: ['reports.view.sales'] }, 'reports.view.*'), false);
  assert.deepEqual(permissionsForRoles(['orders.read', 'menu.view', 'orders.read']), ['menu.view', 'orders.read']);
});

test('realtime broadcasts are mapped to permission-specific rooms', () => {
  assert.ok(realtimeEventPermissions['kot:status'].includes('kds.view'));
  assert.deepEqual(realtimeRoomsForEvent('tenant-1', 'outlet-1', 'menu:updated'), ['tenant:tenant-1:outlet:outlet-1:permission:menu.view']);
  assert.deepEqual(realtimeRoomsForEvent('tenant-1', 'outlet-1', 'sensitive:unknown'), []);
});
