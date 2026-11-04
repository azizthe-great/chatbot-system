'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalDatabase } = require('../src/database/local');
const { ensureAdmin } = require('../src/services/bootstrap');
const { authenticate, createUser } = require('../src/services/auth');

test('the administrator is created once from the ADMIN_* settings', async (t) => {
  const db = await LocalDatabase.create(); t.after(() => db.end());
  assert.equal((await ensureAdmin(db, { name: 'Owner', email: '', password: '' })).status, 'missing');
  await assert.rejects(ensureAdmin(db, { name: 'Owner', email: 'owner@example.test', password: '' }), /ADMIN_EMAIL and ADMIN_PASSWORD/);
  await assert.rejects(ensureAdmin(db, { name: 'Owner', email: 'owner@example.test', password: 'short' }), /12 characters/);
  assert.equal((await ensureAdmin(db, { name: 'Owner', email: 'Owner@Example.test', password: 'Owner-password-1!' })).status, 'created');
  assert.equal((await authenticate(db, 'owner@example.test', 'Owner-password-1!')).role, 'admin');
  // A changed setting never overwrites the existing account's password.
  assert.equal((await ensureAdmin(db, { name: 'Owner', email: 'owner@example.test', password: 'Different-password-2!' })).status, 'exists');
  assert.ok(await authenticate(db, 'owner@example.test', 'Owner-password-1!'));
  assert.equal((await ensureAdmin(db, { name: 'Owner', email: '', password: '' })).status, 'exists');
  await createUser(db, { name: 'Customer', email: 'customer@example.test', password: 'Customer-password-1!', role: 'customer' });
  assert.equal((await ensureAdmin(db, { name: 'Owner', email: 'customer@example.test', password: 'Customer-password-1!' })).status, 'customer');
});
