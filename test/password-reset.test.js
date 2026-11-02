'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resetAdminPassword, authenticate } = require('../src/services/auth');
const { hashPassword, verifyPassword } = require('../src/services/passwords');

const admin = { id: 'admin-id', email: 'admin@example.test', role: 'admin', status: 'active', password_hash: '' };
const customer = { id: 'customer-id', email: 'customer@example.test', role: 'customer', status: 'active', password_hash: '' };

function fakeDb() {
  const users = [structuredClone(admin), structuredClone(customer)];
  const queries = [];
  return {
    users, queries,
    async query(sql, values) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      if (sql.startsWith('SELECT id,email FROM users')) {
        const target = users.filter((u) => u.role === 'admin' && (u.id === values[0] || u.email === values[1]));
        return { rows: target.map(({ id, email }) => ({ id, email })), rowCount: target.length };
      }
      if (sql.startsWith('UPDATE users SET password_hash=')) {
        const row = users.find((u) => u.id === values[1] && u.role === 'admin');
        if (!row) return { rows: [], rowCount: 0 };
        row.password_hash = values[0];
        return { rows: [{ id: row.id, email: row.email, role: row.role }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT id,name,email,password_hash,role,status FROM users')) {
        const row = users.find((u) => u.email === values[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: Number(Boolean(row)) };
      }
      throw new Error('Unexpected query');
    }
  };
}

test('reset changes only the selected existing administrator password hash', async () => {
  const db = fakeDb();
  db.users[0].password_hash = await hashPassword('Old-admin-password!');
  db.users[1].password_hash = await hashPassword('Customer-password!');
  const customerBefore = structuredClone(db.users[1]);
  const result = await resetAdminPassword(db, { identifier: 'admin@example.test', password: 'New-admin-password!' });
  assert.deepEqual(result, { id: 'admin-id', email: 'admin@example.test', role: 'admin' });
  assert.equal(db.users[0].role, 'admin');
  assert.equal(db.users[0].status, 'active');
  assert.equal(await verifyPassword('New-admin-password!', db.users[0].password_hash), true);
  assert.equal(await authenticate(db, 'admin@example.test', 'Old-admin-password!'), null);
  assert.deepEqual(db.users[1], customerBefore);
  assert.equal(db.queries.some((q) => q.sql.startsWith('INSERT')), false);
  const update = db.queries.find((q) => q.sql.startsWith('UPDATE users SET password_hash='));
  assert.match(update.sql, /^UPDATE users SET password_hash=\$1 WHERE id=\$2 AND role='admin'/);
});

test('reset rejects short passwords and identifiers that do not select an administrator', async () => {
  const db = fakeDb();
  await assert.rejects(resetAdminPassword(db, { identifier: 'admin@example.test', password: 'short' }), /at least 12/);
  await assert.rejects(resetAdminPassword(db, { identifier: 'customer@example.test', password: 'Long-password-1!' }), /No administrator/);
  assert.equal(db.queries.length, 1);
});
