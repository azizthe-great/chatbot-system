'use strict';
// Browser-test server: the real app on an in-process PostgreSQL (PGlite) seeded with two accounts.
const { buildApp } = require('../server');
const { createUser } = require('../src/services/auth');
const { TestDatabase } = require('../test/support/database');

(async () => {
  const db = await TestDatabase.create();
  await createUser(db, { name: 'Importer', email: 'importer@example.test', password: 'Importer-password-1!', role: 'customer' });
  await createUser(db, { name: 'Admin', email: 'admin@example.test', password: 'Admin-password-1!', role: 'admin' });
  const app = buildApp({ db, config: { logLevel: 'warn', authRateLimitMax: 1000, globalRateLimitMax: 100000 } });
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT) || 3107 });
})().catch((error) => { console.error(error); process.exit(1); });
