'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../server');
const { createSession, hashToken } = require('../src/services/auth');

function makeDb() {
  const user = { id: 'customer-id', name: 'Test Customer', email: 'customer@example.test', role: 'customer', status: 'active' };
  const sessions = new Map();
  const queries = [];
  return {
    user, sessions, queries,
    async query(sql, values = []) {
      const query = sql.replace(/\s+/g, ' ').trim();
      queries.push(query);
      if (query === 'DELETE FROM sessions WHERE expires_at <= now()') {
        for (const [key, session] of sessions) if (session.expires_at <= new Date()) sessions.delete(key);
        return { rows: [], rowCount: 0 };
      }
      if (query.startsWith('INSERT INTO sessions')) {
        sessions.set(values[0], { user_id: values[1], expires_at: new Date(values[2]) });
        return { rows: [], rowCount: 1 };
      }
      if (query.startsWith('SELECT u.id,u.name,u.email,u.role,u.status,s.expires_at')) {
        const session = sessions.get(values[0]);
        return session && session.expires_at > new Date()
          ? { rows: [{ ...user, expires_at: session.expires_at }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected test database query: ${query}`);
    }
  };
}

async function setup(options = {}) {
  const db = makeDb();
  const app = buildApp({ db, config: { logLevel: 'silent', vehicleLookupTimeoutMs: 100 }, ...options });
  await app.ready();
  const session = await createSession(db, db.user.id, 1);
  return { app, db, cookie: `portside_session=${session.token}` };
}

test('vehicle lookup requires authentication and validates VINs and chassis numbers', async (t) => {
  const ctx = await setup(); t.after(() => ctx.app.close());
  const anonymous = await ctx.app.inject({ method: 'POST', url: '/api/vehicle-lookup', payload: { identifier: 'JTMBE31V006123456' } });
  assert.equal(anonymous.statusCode, 401);
  const invalidVin = await ctx.app.inject({ method: 'POST', url: '/api/vehicle-lookup', headers: { cookie: ctx.cookie }, payload: { identifier: 'JTMBE31V00612345I' } });
  assert.equal(invalidVin.statusCode, 400);
  const invalid = await ctx.app.inject({ method: 'POST', url: '/api/vehicle-lookup', headers: { cookie: ctx.cookie }, payload: { identifier: 'AB / 123' } });
  assert.equal(invalid.statusCode, 400);
  const chassis = await ctx.app.inject({ method: 'POST', url: '/api/vehicle-lookup', headers: { cookie: ctx.cookie }, payload: { identifier: 'zrr80-1234567' } });
  assert.equal(chassis.statusCode, 200);
  assert.equal(chassis.json().identifier, 'ZRR80-1234567');
  assert.equal(chassis.json().identifierType, 'chassis');
  const longChassis = await ctx.app.inject({ method: 'POST', url: '/api/vehicle-lookup', headers: { cookie: ctx.cookie }, payload: { identifier: 'ABCDEF123456789-I' } });
  assert.equal(longChassis.statusCode, 200);
  assert.equal(longChassis.json().identifierType, 'chassis');
});

test('vehicle lookup reports provider-not-configured without inventing vehicle history', async (t) => {
  const ctx = await setup(); t.after(() => ctx.app.close());
  const writesBefore = ctx.db.queries.filter((query) => /^(INSERT|UPDATE|DELETE)/i.test(query)).length;
  const result = await ctx.app.inject({ method: 'POST', url: '/api/vehicle-lookup', headers: { cookie: ctx.cookie }, payload: { identifier: 'JTMBE31V006123456' } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().status, 'unavailable');
  assert.equal(result.json().reason, 'provider_not_configured');
  assert.equal(result.json().data, null);
  assert.match(result.json().message, /no vehicle data provider is configured/i);
  assert.equal(ctx.db.queries.filter((query) => /^(INSERT|UPDATE|DELETE)/i.test(query)).length, writesBefore); // A lookup itself does not write to the database.
});

test('configured provider response is returned with an explicit provider identity', async (t) => {
  const provider = {
    name: 'Test Provider',
    async lookup({ identifier, identifierType, signal }) {
      assert.equal(identifier, 'JTMBE31V006123456');
      assert.equal(identifierType, 'vin');
      assert.equal(signal.aborted, false);
      return { vehicle: { make: 'Toyota', model: 'Harrier', year: 2020 }, history: { mileage: { status: 'unavailable' } } };
    }
  };
  const ctx = await setup({ vehicleProvider: provider }); t.after(() => ctx.app.close());
  const result = await ctx.app.inject({ method: 'POST', url: '/api/vehicle-lookup', headers: { cookie: ctx.cookie }, payload: { identifier: 'jt mbe31v006123456'.replaceAll(' ', '') } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().status, 'available');
  assert.equal(result.json().provider.name, 'Test Provider');
  assert.equal(result.json().data.vehicle.make, 'Toyota');
  assert.equal(result.json().data.history.mileage.status, 'unavailable');
});

test('provider no-match response stays distinct from a clean-history result', async (t) => {
  const ctx = await setup({ vehicleProvider: { name: 'Test Provider', async lookup() { return { status: 'not_found' }; } } });
  t.after(() => ctx.app.close());
  const result = await ctx.app.inject({ method: 'POST', url: '/api/vehicle-lookup', headers: { cookie: ctx.cookie }, payload: { identifier: 'JTMBE31V006123456' } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().status, 'not_found');
  assert.equal(result.json().data, null);
  assert.match(result.json().message, /Missing records do not establish that no history exists/);
});

test('provider errors, rate limits and timeouts produce safe HTTP responses', async (t) => {
  const failing = await setup({ vehicleProvider: { async lookup() { throw new Error('private provider detail'); } } });
  t.after(() => failing.app.close());
  const failed = await failing.app.inject({ method: 'POST', url: '/api/vehicle-lookup', headers: { cookie: failing.cookie }, payload: { identifier: 'JTMBE31V006123456' } });
  assert.equal(failed.statusCode, 502);
  assert.doesNotMatch(failed.body, /private provider detail/);

  const limited = await setup({ vehicleProvider: { async lookup() { const error = new Error('limit'); error.code = 'RATE_LIMITED'; throw error; } } });
  t.after(() => limited.app.close());
  const rateLimited = await limited.app.inject({ method: 'POST', url: '/api/vehicle-lookup', headers: { cookie: limited.cookie }, payload: { identifier: 'JTMBE31V006123456' } });
  assert.equal(rateLimited.statusCode, 429);

  const slow = await setup({ config: { logLevel: 'silent', vehicleLookupTimeoutMs: 10 }, vehicleProvider: { lookup: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) } });
  t.after(() => slow.app.close());
  const timedOut = await slow.app.inject({ method: 'POST', url: '/api/vehicle-lookup', headers: { cookie: slow.cookie }, payload: { identifier: 'JTMBE31V006123456' } });
  assert.equal(timedOut.statusCode, 504);
  assert.equal(timedOut.json().error.code, 'PROVIDER_TIMEOUT');
});
