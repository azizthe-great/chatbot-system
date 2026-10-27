'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./support/app');
const { hashToken, createUser } = require('../src/services/auth');
const { TestDatabase } = require('./support/database');

test('account auth, roles, ownership, validation, admin updates and session invalidation', async (t) => {
  const { db, request, login, accounts } = await setup(t);
  const stored = (await db.query('SELECT password_hash FROM users WHERE email=$1', [accounts.customer.email])).rows[0];
  assert.equal(stored.password_hash.includes('Customer-password'), false);
  assert.equal((await login(accounts.customer.email, 'wrong password')).status, 401);
  const one = await login(accounts.customer.email, accounts.customer.password); assert.equal(one.status, 200);
  const two = await login(accounts.other.email, accounts.other.password);
  const admin = await login(accounts.admin.email, accounts.admin.password);
  assert.equal((await request('GET', '/api/auth/me', undefined, one.cookie)).body.user.role, 'customer');
  assert.equal((await request('GET', '/api/admin/enquiries', undefined, one.cookie)).status, 403);
  assert.equal((await request('POST', '/api/vehicles', { model: 'Harrier' }, one.cookie)).status, 400);
  const createdVehicle = await request('POST', '/api/vehicles', { make: 'Toyota', model: 'Harrier', year: 2019, vin: 'JTM00000000000001' }, one.cookie);
  assert.equal(createdVehicle.status, 201); const vehicleId = createdVehicle.body.vehicle.id;
  assert.equal((await request('GET', `/api/vehicles/${vehicleId}`, undefined, two.cookie)).status, 404);
  assert.equal((await request('PATCH', `/api/vehicles/${vehicleId}`, { model: 'Changed' }, two.cookie)).status, 404);
  const enquiryResp = await request('POST', '/api/enquiries', { category: 'Import advice', description: 'Please contact me.', vehicleId }, one.cookie);
  assert.equal(enquiryResp.status, 201); const enquiry = enquiryResp.body.enquiry;
  assert.match(enquiry.reference, /^PST-\d{4}-[A-F0-9]{8}$/);
  assert.equal((await request('GET', `/api/enquiries/${enquiry.id}`, undefined, two.cookie)).status, 404);
  assert.equal((await request('POST', '/api/enquiries', { category: 'Help', description: 'Not mine', vehicleId }, two.cookie)).status, 404);
  const adminList = await request('GET', '/api/admin/enquiries', undefined, admin.cookie);
  assert.equal(adminList.status, 200); assert.equal(adminList.body.enquiries.length, 1);
  assert.equal((await request('PATCH', `/api/admin/enquiries/${enquiry.id}`, { status: 'resolved', priority: 'high' }, admin.cookie)).status, 200);
  assert.equal((await request('POST', '/api/auth/logout', {}, one.cookie)).status, 200);
  assert.equal((await request('GET', '/api/auth/me', undefined, one.cookie)).status, 401);
  assert.equal((await db.query('SELECT 1 FROM sessions WHERE token_hash=$1', [hashToken(one.cookie)])).rowCount, 0);
  assert.equal((await request('GET', '/api/auth/me', undefined, admin.cookie)).status, 200);
  assert.ok((await db.query('SELECT 1 FROM audit_events')).rowCount >= 5);
});

test('customers cannot use admin tools and admin answers become shared knowledge', async (t) => {
  const { request, login, accounts } = await setup(t);
  assert.equal((await request('GET', '/api/admin')).status, 401);
  const user = await login(accounts.customer.email, accounts.customer.password);
  assert.equal((await request('GET', '/api/admin', undefined, user.cookie)).status, 403);
  assert.equal((await request('POST', '/api/answers', { id: 'fake', answer: 'test' }, user.cookie)).status, 403);
  await request('POST', '/api/activity', { intent: 'unresolved', message: 'Can I import a van?' }, user.cookie);
  const admin = await login(accounts.admin.email, accounts.admin.password);
  const dashboard = await request('GET', '/api/admin', undefined, admin.cookie);
  const question = dashboard.body.unresolved.find((item) => item.question === 'Can I import a van?'); assert.ok(question);
  assert.equal((await request('POST', '/api/answers', { id: question.id, answer: 'Demo answer about vans.' }, admin.cookie)).status, 200);
  assert.ok((await request('GET', '/api/knowledge', undefined, user.cookie)).body.knowledge.some((item) => item.answer === 'Demo answer about vans.'));
});

test('sessions, records, estimates and knowledge remain available after rebuilding the app with the same database', async (t) => {
  const first = await setup();
  const signed = await first.login(first.accounts.customer.email, first.accounts.customer.password);
  await first.request('POST', '/api/vehicles', { make: 'Mazda', model: 'CX-5' }, signed.cookie);
  const c = (await first.request('POST', '/api/conversations', {}, signed.cookie)).body.conversation;
  const quote = await first.request('POST', '/api/services/quote', { conversationId: c.id, requestId: 'q', input: { model: 'Mazda CX-5', registration: '2019-12', engine: 2000, fuel: 'Petrol' } }, signed.cookie);
  await first.request('POST', '/api/quotes', { conversationId: c.id, messageId: quote.body.reply.id }, signed.cookie);
  await first.app.close();
  const restarted = await setup(t, { db: first.db });
  assert.equal((await restarted.request('GET', '/api/vehicles', undefined, signed.cookie)).body.vehicles[0].model, 'CX-5');
  assert.equal((await restarted.request('GET', '/api/quotes', undefined, signed.cookie)).body.total, 1);
  assert.equal((await restarted.request('GET', `/api/conversations/${c.id}`, undefined, signed.cookie)).body.conversation.messages.length, 2);
});

test('duplicate account email is rejected by the database uniqueness constraint', async () => {
  const db = await TestDatabase.create();
  await createUser(db, { name: 'First', email: 'duplicate@example.test', password: 'Long-password-1!', role: 'customer' });
  await assert.rejects(createUser(db, { name: 'Second', email: 'DUPLICATE@example.test', password: 'Long-password-2!', role: 'customer' }), { code: '23505' });
});

test('expired sessions are rejected by current-user and protected API checks', async (t) => {
  const { db, request, login, accounts } = await setup(t);
  const signed = await login(accounts.customer.email, accounts.customer.password);
  await db.query("UPDATE sessions SET expires_at=now() - interval '1 second' WHERE token_hash=$1", [hashToken(signed.cookie)]);
  assert.equal((await request('GET', '/api/auth/me', undefined, signed.cookie)).status, 401);
  assert.equal((await request('GET', '/api/vehicles', undefined, signed.cookie)).status, 401);
});

test('legacy assistant endpoint, security headers and cross-origin protection', async (t) => {
  const { request } = await setup(t);
  const page = await request('GET', '/');
  assert.equal(page.status, 200); assert.match(page.body, /PORTSIDE/); assert.match(page.response.headers['content-security-policy'], /frame-ancestors 'none'/);
  const response = await request('POST', '/api/chat', { message: 'hello' });
  assert.equal(response.status, 200); assert.match(response.body.reply, /hello/i);
  assert.equal((await request('POST', '/api/chat', { message: 'hello' }, undefined, { origin: 'https://attacker.example' })).status, 403);
});
