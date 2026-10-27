'use strict';
const { randomUUID } = require('node:crypto');
async function recordAudit(db, { actorId = null, action, recordType, recordId = null, metadata = {} }) {
  await db.query(
    'INSERT INTO audit_events (id, actor_id, action, record_type, record_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    [randomUUID(), actorId, action, recordType, recordId, JSON.stringify(metadata)]
  );
}
module.exports = { recordAudit };
