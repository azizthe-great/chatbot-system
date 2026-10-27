'use strict';
const { buildApp } = require('../../server');
const { createUser } = require('../../src/services/auth');
const { TestDatabase } = require('./database');

const accounts = {
  customer: { name: 'Customer One', email: 'one@example.test', password: 'Customer-password-1!', role: 'customer' },
  other: { name: 'Customer Two', email: 'two@example.test', password: 'Customer-password-2!', role: 'customer' },
  admin: { name: 'Admin', email: 'admin@example.test', password: 'Admin-password-1!', role: 'admin' }
};

// Builds the app on a fresh migrated database seeded with two customers and an admin.
async function setup(t, { db, config } = {}) {
  db = db || await TestDatabase.create();
  const users = {};
  if (!(await db.query('SELECT 1 FROM users LIMIT 1')).rowCount) for (const [key, account] of Object.entries(accounts)) users[key] = await createUser(db, account);
  const app = buildApp({ db, config: { logLevel: 'silent', authRateLimitMax: 1000, ...config } });
  await app.ready();
  t?.after(async () => { await app.close(); });
  const sessionCookie = (response) => response.cookies.find((item) => item.name === 'portside_session');
  const request = async (method, url, payload, cookie, headers = {}) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers: { ...headers, ...(cookie ? { cookie: `portside_session=${cookie}` } : {}) } });
    let body; try { body = response.json(); } catch { body = response.body; }
    return { status: response.statusCode, body, cookie: sessionCookie(response)?.value, response };
  };
  const login = async (email, password) => request('POST', '/api/auth/login', { email, password });
  return { db, app, users, request, login, accounts };
}

module.exports = { setup, accounts };
