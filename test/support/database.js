'use strict';
const { PGlite } = require('@electric-sql/pglite');
const { migrate } = require('../../src/database/migrations');

// pg reports selected rows in rowCount; PGlite only reports rows changed.
const shape = (result) => ({ rows: result.rows, rowCount: Math.max(result.rows.length, result.affectedRows || 0) });

// Wraps in-process PGlite in the subset of the pg Pool interface the app uses.
// PGlite has one connection, so every query and checked-out client takes turns on a lock.
class TestDatabase {
  constructor(pg) { this.pg = pg; this.lock = Promise.resolve(); }
  static async create() {
    const db = new TestDatabase(new PGlite());
    await migrate(db);
    return db;
  }
  async run(sql, values) {
    // Parameterless SQL may hold several statements (migrations), which only exec supports.
    if (!values?.length) {
      const results = await this.pg.exec(sql);
      return shape(results.at(-1) || { rows: [] });
    }
    return shape(await this.pg.query(sql, values));
  }
  async query(sql, values) {
    const client = await this.connect();
    try { return await client.query(sql, values); } finally { client.release(); }
  }
  async connect() {
    let release;
    const previous = this.lock;
    this.lock = previous.then(() => new Promise((resolve) => { release = resolve; }));
    await previous;
    return { query: (sql, values) => this.run(sql, values), release: () => release() };
  }
  async end() { await this.pg.close(); }
}

module.exports = { TestDatabase };
