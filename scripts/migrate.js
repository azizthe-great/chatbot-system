'use strict';
const { getPool, closePool } = require('../src/database/pool');
const { migrate } = require('../src/database/migrations');
(async () => {
  try {
    const files = await migrate(getPool());
    console.log(files.length ? `Database schema current (${files.join(', ')}).` : 'Database schema is already current.');
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally { await closePool(); }
})();
