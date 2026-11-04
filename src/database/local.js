'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { migrate } = require('./migrations');

// pg reports selected rows in rowCount; PGlite only reports rows changed.
const shape = (result) => ({ rows: result.rows, rowCount: Math.max(result.rows.length, result.affectedRows || 0) });

// PGlite does not stop a second process opening the same files, and two writers corrupt them,
// so a lock file next to the data directory records the owning process.
function claimDirectory(dataDir) {
  const lockFile = `${dataDir}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      process.once('exit', () => fs.rmSync(lockFile, { force: true }));
      return lockFile;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(fs.readFileSync(lockFile, 'utf8'));
      if (owner && owner !== process.pid && isRunning(owner)) throw new Error(`The local database is in use by another Portside process (pid ${owner}). Stop the server first.`);
      fs.rmSync(lockFile, { force: true }); // left behind by a process that has exited
    }
  }
  throw new Error(`Could not lock the local database at ${dataDir}.`);
}
function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// PostgreSQL running inside the Node process (PGlite), wrapped in the subset of the pg Pool
// interface the app uses. It needs no database server: data lives in dataDir, or in memory
// when dataDir is omitted. PGlite has one connection, so every query and checked-out client
// takes turns on a lock, and only one process can open a data directory at a time.
class LocalDatabase {
  constructor(dataDir) {
    if (dataDir) this.lockFile = claimDirectory(dataDir);
    this.pg = new PGlite(dataDir); this.lock = Promise.resolve();
  }
  static async create(dataDir) {
    const db = new LocalDatabase(dataDir);
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
  async end() {
    await this.pg.close();
    if (this.lockFile) { fs.rmSync(this.lockFile, { force: true }); this.lockFile = undefined; }
  }
}

module.exports = { LocalDatabase };
