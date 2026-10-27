'use strict';
const { Pool } = require('pg');
const config = require('../config');
let pool;

function getPool() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
    pool = new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
    pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error.message));
  }
  return pool;
}
function setPool(value) { pool = value; }
async function closePool() { if (pool) await pool.end(); pool = undefined; }
module.exports = { getPool, setPool, closePool };
