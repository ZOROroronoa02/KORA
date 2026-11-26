import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransactionConflict } from '../src/lib/db-conflicts.ts';

test('database conflict detection includes Prisma and raw SQL serialization errors', () => {
  assert.equal(isTransactionConflict({ code: 'P2034' }), true);
  assert.equal(isTransactionConflict({ code: 'P2010', meta: { code: '40001' } }), true);
  assert.equal(isTransactionConflict({ code: 'P2010', meta: { code: '40P01' } }), true);
  assert.equal(isTransactionConflict({ code: 'P2010', meta: { code: '42P01' } }), false);
  assert.equal(isTransactionConflict({ code: 'P2002' }), false);
  assert.equal(isTransactionConflict(null), false);
});
