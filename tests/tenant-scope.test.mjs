import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { applyPrismaTenantScope } from '../src/lib/tenant-scope.ts';

const scope = { tenantId: 'tenant-a', outletId: 'outlet-a', userId: 'user-a' };

test('tenant scope overrides client tenant and outlet selectors on direct model reads', () => {
  const args = applyPrismaTenantScope('Order', 'findMany', {
    where: { tenantId: 'tenant-b', outletId: 'outlet-b', status: 'OPEN' },
  }, scope);
  assert.deepEqual(args, {
    where: { tenantId: 'tenant-a', outletId: 'outlet-a', status: 'OPEN' },
  });
});

test('tenant scope preserves existing unique filters while adding relation ownership', () => {
  const args = applyPrismaTenantScope('Payment', 'findUnique', {
    where: { id: 'payment-1' },
  }, scope);
  assert.deepEqual(args, {
    where: {
      id: 'payment-1',
      AND: [{ bill: { tenantId: 'tenant-a', outletId: 'outlet-a' } }],
    },
  });
});

test('refund ledger reads and writes are scoped to both tenant and outlet', () => {
  assert.deepEqual(applyPrismaTenantScope('PaymentReversal', 'findMany', {
    where: { outletId: 'outlet-b', id: 'refund-1' },
  }, scope), {
    where: { outletId: 'outlet-a', tenantId: 'tenant-a', id: 'refund-1', AND: [{ payment: { bill: { tenantId: 'tenant-a', outletId: 'outlet-a' } } }] },
  });
  assert.deepEqual(applyPrismaTenantScope('PaymentReversal', 'create', {
    data: { paymentId: 'payment-1', amountPaise: 500n },
  }, scope), {
    data: { paymentId: 'payment-1', amountPaise: 500n, tenantId: 'tenant-a', outletId: 'outlet-a' },
  });
});

test('staff invitation reads, writes, and relation filters stay within tenant and selected outlet', () => {
  assert.deepEqual(applyPrismaTenantScope('StaffInvitation', 'findMany', {
    where: { tenantId: 'tenant-b', outletId: 'outlet-b', email: 'staff@example.test' },
  }, scope), {
    where: {
      tenantId: 'tenant-a', outletId: 'outlet-a', email: 'staff@example.test',
      AND: [{
        outlet: { tenantId: 'tenant-a' },
        role: { tenantId: 'tenant-a', OR: [{ outletId: null }, { outletId: 'outlet-a' }] },
        createdBy: { tenantId: 'tenant-a' },
      }],
    },
  });
  assert.throws(() => applyPrismaTenantScope('StaffInvitation', 'create', {
    data: { tenantId: 'tenant-b', outletId: 'outlet-b' },
  }, scope), /attempted to change its tenantId scope/);
});

test('recipe and BOM Prisma queries are scoped to the selected outlet', () => {
  assert.deepEqual(applyPrismaTenantScope('Recipe', 'findMany', { where: { outletId: 'outlet-b' } }, scope), {
    where: { outletId: 'outlet-a', tenantId: 'tenant-a' },
  });
  assert.deepEqual(applyPrismaTenantScope('RecipeIngredient', 'findMany', {}, scope), {
    where: { AND: [{ recipe: { tenantId: 'tenant-a', outletId: 'outlet-a' }, rawMaterial: { tenantId: 'tenant-a', outletId: 'outlet-a' } }] },
  });
});

test('tenant scope injects server-owned ownership fields on creates', () => {
  const args = applyPrismaTenantScope('Order', 'create', {
    data: { outletId: 'outlet-a', type: 'TAKEAWAY' },
  }, scope);
  assert.deepEqual(args, {
    data: { tenantId: 'tenant-a', outletId: 'outlet-a', type: 'TAKEAWAY' },
  });
  assert.throws(() => applyPrismaTenantScope('Order', 'create', {
    data: { tenantId: 'tenant-b', outletId: 'outlet-b' },
  }, scope), /attempted to change its tenantId scope/);
});

test('tenant scope rejects ownership changes in updates and upserts', () => {
  assert.throws(() => applyPrismaTenantScope('Order', 'updateMany', {
    where: { status: 'OPEN' }, data: { tenantId: 'tenant-b' },
  }, scope), /attempted to change its tenantId scope/);
  assert.throws(() => applyPrismaTenantScope('Order', 'upsert', {
    where: { id: 'order-1' },
    create: { type: 'DINE_IN' },
    update: { outletId: 'outlet-b' },
  }, scope), /attempted to change its outletId scope/);
  assert.deepEqual(applyPrismaTenantScope('Order', 'update', {
    where: { id: 'order-1' }, data: { status: 'COMPLETED' },
  }, scope), {
    where: { id: 'order-1', tenantId: 'tenant-a', outletId: 'outlet-a' },
    data: { status: 'COMPLETED' },
  });
});

test('tenant-wide categories stay visible while outlet-specific categories remain isolated', () => {
  const args = applyPrismaTenantScope('MenuCategory', 'findMany', {
    where: { OR: [{ active: true }, { name: 'Special' }] },
  }, scope);
  assert.deepEqual(args, {
    where: {
      OR: [{ active: true }, { name: 'Special' }],
      tenantId: 'tenant-a',
      AND: [{ OR: [{ outletId: null }, { outletId: 'outlet-a' }] }],
    },
  });
});

test('outlet queries stay tenant-scoped except for verified platform-admin session listing', () => {
  assert.deepEqual(applyPrismaTenantScope('Outlet', 'findMany', {}, scope), {
    where: { tenantId: 'tenant-a' },
  });
  assert.deepEqual(applyPrismaTenantScope('Outlet', 'findMany', {}, {
    ...scope, platformOutletListing: true,
  }), { where: {} });
});

test('new Prisma models fail closed until a tenant policy is registered', () => {
  assert.throws(() => applyPrismaTenantScope('UnregisteredModel', 'findMany', {}, scope), /No tenant-scope policy/);
});

test('every business API route establishes tenant scope; only auth bootstrap and health are exempt', () => {
  const apiRoot = join(process.cwd(), 'src', 'app', 'api');
  const exemptions = new Set([
    'auth/login/route.ts',
    'auth/register/route.ts',
    'auth/invitations/resolve/route.ts',
    'auth/invitations/accept/route.ts',
    'auth/refresh/route.ts',
    'auth/logout/route.ts',
    'health/route.ts',
    'health/live/route.ts',
    'health/ready/route.ts',
  ]);
  const routeFiles = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === 'route.ts') routeFiles.push(path);
    }
  };
  visit(apiRoot);

  for (const routeFile of routeFiles) {
    const routeName = relative(apiRoot, routeFile).replaceAll('\\', '/');
    if (exemptions.has(routeName)) continue;
    const source = readFileSync(routeFile, 'utf8');
    assert.match(source, /withTenantScope\(/, `${routeName} must run through the tenant-scoped Route Handler wrapper`);
  }
});
