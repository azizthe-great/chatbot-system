'use strict';
const { Pool } = require('pg');
const config = require('../config');
const { LocalDatabase } = require('./local');
const { migrate } = require('./migrations');
let pool;

// Uses PostgreSQL when DATABASE_URL is set, otherwise the built-in local database in config.dataDir.
function getPool() {
  if (!pool) {
    if (!config.databaseUrl) pool = new LocalDatabase(config.dataDir);
    else {
      pool = new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
      pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error.message));
    }
  }
  return pool;
}
// The local database is migrated on open so it works with no setup; PostgreSQL uses npm run db:migrate.
async function openDatabase() {
  const db = getPool();
  if (db instanceof LocalDatabase) await migrate(db);
  return db;
}
function setPool(value) { pool = value; }
async function closePool() { if (pool) await pool.end(); pool = undefined; }
module.exports = { getPool, openDatabase, setPool, closePool };
