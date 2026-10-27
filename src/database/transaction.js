'use strict';
// Runs fn inside a transaction when db is a pool; a client that is already checked out is used as is.
async function withTransaction(db, fn) {
  if (typeof db.connect !== 'function') return fn(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
module.exports = { withTransaction };
