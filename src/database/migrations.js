'use strict';
const fs = require('node:fs');
const path = require('node:path');

async function migrate(pool, directory = path.resolve(__dirname, '../../migrations')) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = fs.readdirSync(directory).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const name of files) {
    const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (exists.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(directory, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  return files;
}
module.exports = { migrate };
