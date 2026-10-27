'use strict';
const { randomUUID } = require('node:crypto');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../database/transaction');
const { httpError, normalize, idParams, paginate } = require('../http');

const INTENTS = ['quote', 'advisor', 'vin', 'tracking', 'unresolved', 'help', 'knowledge'];
const day = { type: 'string', pattern: '^(\\d{4}-\\d{2}-\\d{2})?$' };
const page = { type: 'integer', minimum: 1, maximum: 100000 };
// Dashboard days are Kenya calendar days; $1 and $2 are the optional from/to dates.
const inRange = (column) => `($1::date IS NULL OR (${column} AT TIME ZONE 'Africa/Nairobi')::date >= $1::date) AND ($2::date IS NULL OR (${column} AT TIME ZONE 'Africa/Nairobi')::date <= $2::date)`;
const answerText = { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' };

function registerAdminRoutes(app, { db, requireUser, requireAdmin }) {
  const admin = [requireUser, requireAdmin];
  app.get('/api/admin', { onRequest: admin, schema: { querystring: { type: 'object', properties: { from: day, to: day, search: { type: 'string', maxLength: 100 }, queuePage: page, knowledgePage: page } } } }, async (request) => {
    // Empty filter fields arrive as empty strings and mean no limit.
    const from = request.query.from || null, to = request.query.to || null, search = request.query.search || '';
    if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to))) || (from && to && from > to)) throw httpError(400, 'VALIDATION_ERROR', 'Choose a valid date range.');
    const range = [from, to];
    const intentRows = (await db.query(`SELECT intent, count(*)::int AS n FROM query_events WHERE ${inRange('created_at')} GROUP BY intent`, range)).rows;
    const counts = Object.fromEntries(INTENTS.map((intent) => [intent, intentRows.find((row) => row.intent === intent)?.n || 0]));
    const chats = (await db.query(
      `SELECT count(*)::int AS active, count(*) FILTER (WHERE completed)::int AS completed FROM conversations c
        WHERE ${inRange('c.created_at')} AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id)`, range)).rows[0];
    const unresolvedTotal = (await db.query('SELECT count(*)::int AS n FROM unresolved_questions')).rows[0].n;
    const modelRows = (await db.query(
      `SELECT result->'input'->>'model' AS model, count(*)::int AS n FROM messages
        WHERE result->'input'->>'model' IS NOT NULL AND ${inRange('created_at')} GROUP BY 1`, range)).rows;
    const queue = await paginate(db, {
      count: `SELECT count(*)::int AS total FROM unresolved_questions WHERE strpos(lower(question), lower($3)) > 0 AND ${inRange('created_at')}`,
      list: `SELECT id,question,created_at AS "at" FROM unresolved_questions WHERE strpos(lower(question), lower($3)) > 0 AND ${inRange('created_at')} ORDER BY created_at, id`,
      values: [...range, search], page: request.query.queuePage
    });
    const knowledgePage = await paginate(db, {
      count: `SELECT count(*)::int AS total FROM knowledge WHERE strpos(lower(question || ' ' || answer), lower($1)) > 0`,
      list: `SELECT id,question,answer,updated_at AS "updatedAt" FROM knowledge WHERE strpos(lower(question || ' ' || answer), lower($1)) > 0 ORDER BY created_at, id`,
      values: [search], page: request.query.knowledgePage
    });
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return {
      counts,
      metrics: { total, quotes: counts.quote, unresolved: unresolvedTotal, conversations: chats.active, completed: chats.completed, completionRate: chats.active ? Math.round(chats.completed / chats.active * 100) : null },
      queue, knowledgePage, models: Object.fromEntries(modelRows.map((row) => [row.model, row.n])), updatedAt: new Date().toISOString(),
      unresolved: queue.items, knowledge: knowledgePage.items
    };
  });

  app.post('/api/answers', { onRequest: admin, schema: { body: { type: 'object', additionalProperties: false, required: ['id', 'answer'], properties: { id: { type: 'string', format: 'uuid' }, answer: answerText } } } }, async (request) => {
    await withTransaction(db, async (client) => {
      const question = (await client.query('DELETE FROM unresolved_questions WHERE id=$1 RETURNING question,question_key', [request.body.id])).rows[0];
      if (!question) throw httpError(409, 'CONFLICT', 'Question no longer available. Refresh the dashboard.');
      await client.query(
        `INSERT INTO knowledge (id,question,question_key,answer) VALUES ($1,$2,$3,$4)
         ON CONFLICT (question_key) DO UPDATE SET answer=EXCLUDED.answer,updated_at=now()`,
        [randomUUID(), question.question, question.question_key, request.body.answer.trim()]
      );
    });
    await recordAudit(db, { actorId: request.user.id, action: 'knowledge.answer', recordType: 'unresolved_question', recordId: request.body.id });
    return { ok: true };
  });
  app.post('/api/admin/knowledge', { onRequest: admin, schema: { body: { type: 'object', additionalProperties: false, required: ['question', 'answer'], properties: { id: { type: 'string', format: 'uuid' }, question: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' }, answer: answerText } } } }, async (request) => {
    const { id } = request.body, question = request.body.question.trim(), answer = request.body.answer.trim();
    let result;
    try {
      result = id
        ? await db.query('UPDATE knowledge SET question=$1,question_key=$2,answer=$3,updated_at=now() WHERE id=$4 RETURNING id,question,answer,updated_at AS "updatedAt"', [question, normalize(question), answer, id])
        : await db.query('INSERT INTO knowledge (id,question,question_key,answer) VALUES ($1,$2,$3,$4) RETURNING id,question,answer,updated_at AS "updatedAt"', [randomUUID(), question, normalize(question), answer]);
    } catch (error) {
      if (error.code === '23505') throw httpError(409, 'CONFLICT', 'An answer already exists for that question.');
      throw error;
    }
    if (!result.rowCount) throw httpError(404, 'NOT_FOUND', 'Answer not found.');
    const item = result.rows[0];
    await recordAudit(db, { actorId: request.user.id, action: id ? 'knowledge.update' : 'knowledge.create', recordType: 'knowledge', recordId: item.id });
    return { item };
  });
  app.delete('/api/admin/knowledge/:id', { onRequest: admin, schema: { params: idParams } }, async (request) => {
    const result = await db.query('DELETE FROM knowledge WHERE id=$1', [request.params.id]);
    if (!result.rowCount) throw httpError(404, 'NOT_FOUND', 'Answer not found.');
    await recordAudit(db, { actorId: request.user.id, action: 'knowledge.delete', recordType: 'knowledge', recordId: request.params.id });
    return { ok: true };
  });
  app.delete('/api/admin/questions/:id', { onRequest: admin, schema: { params: idParams } }, async (request) => {
    const result = await db.query('DELETE FROM unresolved_questions WHERE id=$1', [request.params.id]);
    if (!result.rowCount) throw httpError(404, 'NOT_FOUND', 'Question not found.');
    await recordAudit(db, { actorId: request.user.id, action: 'question.dismiss', recordType: 'unresolved_question', recordId: request.params.id });
    return { ok: true };
  });
}

module.exports = { registerAdminRoutes };
