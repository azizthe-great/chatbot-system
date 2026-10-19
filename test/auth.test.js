'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { buildApp } = require('../server');
const { createUser, hashToken } = require('../src/services/auth');

class TestDatabase {
  constructor() { this.users = new Map(); this.sessions = new Map(); this.vehicles = new Map(); this.enquiries = new Map(); this.audits = []; }
  async query(sql, values = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (q === 'DELETE FROM sessions WHERE expires_at <= now()') { for (const [key, session] of this.sessions) if (session.expires_at <= new Date()) this.sessions.delete(key); return { rows: [], rowCount: 0 }; }
    if (q.startsWith('INSERT INTO users')) {
      const [id, name, email, password_hash, role] = values;
      if ([...this.users.values()].some((user) => user.email.toLowerCase() === email.toLowerCase())) { const err = new Error('unique'); err.code = '23505'; throw err; }
      const user = { id, name, email, password_hash, role, status: 'active', created_at: new Date() }; this.users.set(id, user);
      return { rows: [{ id, name, email, role, status: 'active', created_at: user.created_at }], rowCount: 1 };
    }
    if (q.startsWith('INSERT INTO customer_profiles')) return { rows: [], rowCount: 1 };
    if (q.startsWith('SELECT id,name,email,password_hash,role,status FROM users')) {
      const user = [...this.users.values()].find((item) => item.email.toLowerCase() === values[0]); return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
    }
    if (q.startsWith('INSERT INTO sessions')) { this.sessions.set(values[0], { token_hash: values[0], user_id: values[1], expires_at: new Date(values[2]) }); return { rows: [], rowCount: 1 }; }
    if (q.startsWith('SELECT u.id,u.name,u.email,u.role,u.status,s.expires_at')) {
      const session = this.sessions.get(values[0]); const user = session && this.users.get(session.user_id);
      return session && user && session.expires_at > new Date() && user.status === 'active' ? { rows: [{ id: user.id, name: user.name, email: user.email, role: user.role, status: user.status, expires_at: session.expires_at }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (q.startsWith('DELETE FROM sessions')) { const n = this.sessions.delete(values[0]); return { rows: [], rowCount: Number(n) }; }
    if (q.startsWith('INSERT INTO audit_events')) { this.audits.push(values); return { rows: [], rowCount: 1 }; }
    if (q.startsWith('INSERT INTO vehicles')) {
      const [id, customer_id, make, model, year, engine_capacity_cc, fuel_type, origin_country, vin] = values;
      if (vin && [...this.vehicles.values()].some((v) => v.vin?.toUpperCase() === vin.toUpperCase())) { const err = new Error('unique'); err.code = '23505'; throw err; }
      const vehicle = { id, customer_id, make, model, year, engineCapacityCc: engine_capacity_cc, fuelType: fuel_type, originCountry: origin_country, vin, created_at: new Date(), updated_at: new Date() }; this.vehicles.set(id, vehicle); return { rows: [vehicle], rowCount: 1 };
    }
    if (q.startsWith('SELECT id,make,model,year,engine_capacity_cc AS "engineCapacityCc"')) {
      const owner = values[0]; const rows = [...this.vehicles.values()].filter((v) => v.customer_id === owner);
      if (q.includes('WHERE id=$1 AND customer_id=$2')) {
        const found = this.vehicles.get(values[0]); const row = found?.customer_id === values[1] ? found : null; return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows, rowCount: rows.length };
    }
    if (q.startsWith('SELECT 1 FROM vehicles')) { const v = this.vehicles.get(values[0]); const ok = v?.customer_id === values[1]; return { rows: ok ? [{ '?column?': 1 }] : [], rowCount: ok ? 1 : 0 }; }
    if (q.startsWith('UPDATE vehicles SET')) {
      const id = values[values.length - 2]; const owner = values[values.length - 1]; const vehicle = this.vehicles.get(id);
      if (!vehicle || vehicle.customer_id !== owner) return { rows: [], rowCount: 0 };
      const columns = [...q.matchAll(/([a-z_]+)=\$\d+/g)].map((m) => m[1]);
      const map = { engine_capacity_cc: 'engineCapacityCc', fuel_type: 'fuelType', origin_country: 'originCountry' };
      columns.forEach((column, index) => { const key = map[column] || column; if (key !== 'updated_at') vehicle[key] = values[index]; }); vehicle.updated_at = new Date(); return { rows: [vehicle], rowCount: 1 };
    }
    if (q.startsWith('INSERT INTO enquiries')) {
      const [id, reference, customer_id, vehicle_id, category, description] = values;
      if ([...this.enquiries.values()].some((e) => e.reference === reference)) { const err = new Error('unique'); err.code = '23505'; throw err; }
      const enquiry = { id, reference, customer_id, vehicleId: vehicle_id, category, description, status: 'new', priority: 'normal', created_at: new Date(), updated_at: new Date() }; this.enquiries.set(id, enquiry); return { rows: [enquiry], rowCount: 1 };
    }
    if (q.startsWith('SELECT id,reference,vehicle_id AS "vehicleId"')) {
      if (q.includes('WHERE id=$1 AND customer_id=$2')) { const e = this.enquiries.get(values[0]); const row = e?.customer_id === values[1] ? e : null; return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }; }
      const rows = [...this.enquiries.values()].filter((e) => e.customer_id === values[0]); return { rows, rowCount: rows.length };
    }
    if (q.startsWith('SELECT e.id,e.reference,e.customer_id AS "customerId"')) {
      const rows = [...this.enquiries.values()].map((e) => ({ ...e, customerId: e.customer_id, customerName: this.users.get(e.customer_id).name, customerEmail: this.users.get(e.customer_id).email })); return { rows, rowCount: rows.length };
    }
    if (q.startsWith('UPDATE enquiries SET')) {
      const id = values[values.length - 1]; const enquiry = this.enquiries.get(id); if (!enquiry) return { rows: [], rowCount: 0 };
      const cols = [...q.matchAll(/([a-z_]+)=\$\d+/g)].map((m) => m[1]); cols.forEach((col, index) => { enquiry[col] = values[index]; }); enquiry.updated_at = new Date(); return { rows: [enquiry], rowCount: 1 };
    }
    throw new Error(`Unexpected test database query: ${q}`);
  }
}

async function setup() {
  const db = new TestDatabase();
  const customer = await createUser(db, { name: 'Customer One', email: 'one@example.test', password: 'Customer-password-1!', role: 'customer' });
  const other = await createUser(db, { name: 'Customer Two', email: 'two@example.test', password: 'Customer-password-2!', role: 'customer' });
  const admin = await createUser(db, { name: 'Admin', email: 'admin@example.test', password: 'Admin-password-1!', role: 'admin' });
  const app = buildApp({ db, config: { logLevel: 'silent' } }); await app.ready();
  const login = async (email, password) => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    return { response, cookie: response.cookies.find((item) => item.name === 'portside_session')?.value };
  };
  const authHeaders = (cookie) => ({ cookie: `portside_session=${cookie}` });
  return { db, app, customer, other, admin, login, authHeaders };
}

test('account auth, roles, ownership, validation, admin updates and session invalidation', async (t) => {
  const ctx = await setup(); t.after(() => ctx.app.close());
  const { app, db, customer, other, admin, login, authHeaders } = ctx;
  assert.equal(db.users.get(customer.id).password_hash.includes('Customer-password'), false);
  const bad = await login('one@example.test', 'wrong password'); assert.equal(bad.response.statusCode, 401);
  const one = await login('one@example.test', 'Customer-password-1!'); assert.equal(one.response.statusCode, 200);
  const two = await login('two@example.test', 'Customer-password-2!');
  const adminLogin = await login('admin@example.test', 'Admin-password-1!');
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(one.cookie) })).json().user.role, 'customer');
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/enquiries', headers: authHeaders(one.cookie) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/vehicles', headers: authHeaders(one.cookie), payload: { model: 'Harrier' } })).statusCode, 400);
  const createdVehicle = await app.inject({ method: 'POST', url: '/api/vehicles', headers: authHeaders(one.cookie), payload: { make: 'Toyota', model: 'Harrier', year: 2019, vin: 'JTM00000000000001' } });
  assert.equal(createdVehicle.statusCode, 201); const vehicleId = createdVehicle.json().vehicle.id;
  assert.equal((await app.inject({ method: 'GET', url: `/api/vehicles/${vehicleId}`, headers: authHeaders(two.cookie) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/vehicles/${vehicleId}`, headers: authHeaders(two.cookie), payload: { model: 'Changed' } })).statusCode, 404);
  const enquiryResp = await app.inject({ method: 'POST', url: '/api/enquiries', headers: authHeaders(one.cookie), payload: { category: 'Import advice', description: 'Please contact me.', vehicleId } });
  assert.equal(enquiryResp.statusCode, 201); const enquiry = enquiryResp.json().enquiry;
  assert.match(enquiry.reference, /^PST-\d{4}-[A-F0-9]{8}$/);
  assert.equal((await app.inject({ method: 'GET', url: `/api/enquiries/${enquiry.id}`, headers: authHeaders(two.cookie) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/enquiries', headers: authHeaders(two.cookie), payload: { category: 'Help', description: 'Not mine', vehicleId } })).statusCode, 404);
  const adminList = await app.inject({ method: 'GET', url: '/api/admin/enquiries', headers: authHeaders(adminLogin.cookie) });
  assert.equal(adminList.statusCode, 200); assert.equal(adminList.json().enquiries.length, 1);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/admin/enquiries/${enquiry.id}`, headers: authHeaders(adminLogin.cookie), payload: { status: 'resolved', priority: 'high' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: authHeaders(one.cookie) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(one.cookie) })).statusCode, 401);
  assert.equal(db.sessions.has(hashToken(one.cookie)), false);
  assert.ok(db.audits.length >= 5);
});

test('sessions and records remain available after rebuilding the app with the same database', async (t) => {
  const ctx = await setup(); const { db, app, login, authHeaders } = ctx;
  const signed = await login('one@example.test', 'Customer-password-1!');
  await app.inject({ method: 'POST', url: '/api/vehicles', headers: authHeaders(signed.cookie), payload: { make: 'Mazda', model: 'CX-5' } });
  await app.close();
  const restarted = buildApp({ db, config: { logLevel: 'silent' } }); await restarted.ready(); t.after(() => restarted.close());
  const response = await restarted.inject({ method: 'GET', url: '/api/vehicles', headers: authHeaders(signed.cookie) });
  assert.equal(response.statusCode, 200); assert.equal(response.json().vehicles[0].model, 'CX-5');
});

test('duplicate account email is rejected by the database uniqueness constraint', async () => {
  const db = new TestDatabase();
  await createUser(db, { name: 'First', email: 'duplicate@example.test', password: 'Long-password-1!', role: 'customer' });
  await assert.rejects(createUser(db, { name: 'Second', email: 'DUPLICATE@example.test', password: 'Long-password-2!', role: 'customer' }), { code: '23505' });
});

test('expired sessions are rejected by current-user and protected API checks', async (t) => {
  const ctx = await setup(); t.after(() => ctx.app.close());
  const signed = await ctx.login('one@example.test', 'Customer-password-1!');
  ctx.db.sessions.set(hashToken(signed.cookie), { user_id: ctx.customer.id, expires_at: new Date(Date.now() - 1000) });
  assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: ctx.authHeaders(signed.cookie) })).statusCode, 401);
  assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/vehicles', headers: ctx.authHeaders(signed.cookie) })).statusCode, 401);
});

test('legacy assistant endpoint remains operational', async (t) => {
  const ctx = await setup(); t.after(() => ctx.app.close());
  const page = await ctx.app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200); assert.match(page.body, /PORTSIDE/);
  const response = await ctx.app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hello' } });
  assert.equal(response.statusCode, 200); assert.match(response.json().reply, /hello/i);
});
