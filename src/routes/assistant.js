'use strict';
const { randomUUID } = require('node:crypto');
const { getReply } = require('../../chatbot');
const { models, currentMonth, runService } = require('../services/import-services');
const { withTransaction } = require('../database/transaction');
const { httpError, normalize, idParams, pageQuery, paginate } = require('../http');

const SERVICES = ['quote', 'advisor', 'vin', 'tracking'];
const INTENTS = [...SERVICES, 'help', 'knowledge', 'unresolved'];
const CONVERSATION_COLUMNS = 'id,title,completed,created_at AS "createdAt",updated_at AS "updatedAt"';
const MESSAGE_COLUMNS = 'id,role,content,request_id AS "requestId",action,service,result,created_at AS "at"';
const text = { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' };
const requestId = { type: 'string', minLength: 1, maxLength: 100 };

function classify(message) {
  const normalized = normalize(message);
  if (/\b(track|tracking|shipment|container|bl)\b/.test(normalized)) return 'tracking';
  if (/\b(vin|history|accident|odometer|auction)\b/.test(normalized)) return 'vin';
  if (/\b(when|timing|wait|depreciation|advisor)\b/.test(normalized)) return 'advisor';
  if (/\b(quote|cost|duty|tax|price)\b/.test(normalized)) return 'quote';
  if (/\b(hello|hi|hey|help|start)\b/.test(normalized)) return 'help';
  return 'unresolved';
}
const replies = {
  unresolved: 'Your question has been saved for admin review. An answer will be available when an admin adds it to the knowledge base.',
  help: 'Karibu! Choose a landed-cost estimate, timing comparison, vehicle history check or shipment tracking.',
  service: 'Complete the service form below to continue.'
};
// Null columns are left out so the client sees the same message shape as before.
const messageView = (row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

async function recordQuery(db, { userId, conversationId = null, intent, message }) {
  await db.query('INSERT INTO query_events (id,user_id,conversation_id,intent,message) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), userId, conversationId, intent, message]);
  if (intent === 'unresolved') {
    await db.query('INSERT INTO unresolved_questions (id,question,question_key) VALUES ($1,$2,$3) ON CONFLICT (question_key) DO NOTHING', [randomUUID(), message, normalize(message)]);
  }
}

function registerAssistantRoutes(app, { db, requireUser }) {
  async function ownedConversation(client, id, userId, lock = false) {
    const result = await client.query(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id=$1 AND user_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, userId]);
    if (!result.rowCount) throw httpError(404, 'NOT_FOUND', 'Conversation not found.');
    return result.rows[0];
  }
  async function loadConversation(id, userId) {
    const conversation = await ownedConversation(db, id, userId);
    const messages = await db.query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id=$1 ORDER BY seq`, [id]);
    return { ...conversation, messages: messages.rows.map(messageView) };
  }
  async function storedReply(conversationId, request) {
    const result = await db.query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id=$1 AND request_id=$2 AND role='assistant'`, [conversationId, request]);
    return result.rows[0] && messageView(result.rows[0]);
  }

  // Runs produce() once per (conversation, requestId); retries return the stored reply.
  const inflight = new Map();
  async function exchange(user, conversationId, request, produce) {
    const conversation = await ownedConversation(db, conversationId, user.id);
    const existing = await storedReply(conversationId, request);
    if (existing) return { conversation: await loadConversation(conversationId, user.id), reply: existing };
    if (conversation.completed) throw httpError(400, 'CONVERSATION_COMPLETE', 'This conversation is complete. Start a new chat to continue.');
    const key = `${conversationId}:${request}`;
    if (inflight.has(key)) return inflight.get(key);
    const task = (async () => {
      const { intent, message, reply } = await produce();
      try {
        await withTransaction(db, async (client) => {
          const current = await ownedConversation(client, conversationId, user.id, true);
          if (current.completed) throw httpError(400, 'CONVERSATION_COMPLETE', 'Conversation is complete.');
          await client.query('INSERT INTO messages (id,conversation_id,role,content,request_id) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), conversationId, 'user', message, request]);
          await client.query('INSERT INTO messages (id,conversation_id,role,content,request_id,action,service,result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [randomUUID(), conversationId, 'assistant', reply.content, request, reply.action || null, reply.service || null, reply.result ? JSON.stringify(reply.result) : null]);
          await client.query("UPDATE conversations SET updated_at=now(),title=CASE WHEN title='New conversation' THEN $2 ELSE title END WHERE id=$1", [conversationId, message.slice(0, 70)]);
          await recordQuery(client, { userId: user.id, conversationId, intent, message });
        });
      } catch (error) {
        // Another server process stored this request first; return its reply.
        if (error.code !== '23505') throw error;
      }
      return { conversation: await loadConversation(conversationId, user.id), reply: await storedReply(conversationId, request) };
    })();
    inflight.set(key, task);
    try { return await task; } finally { inflight.delete(key); }
  }

  app.get('/api/catalog', { onRequest: requireUser }, async () => ({
    models, currentMonth: currentMonth(),
    providers: Object.fromEntries(SERVICES.map((key) => [key, !!process.env[`PORTSIDE_${key.toUpperCase()}_URL`]]))
  }));

  app.get('/api/conversations', { onRequest: requireUser, schema: { querystring: pageQuery('page') } }, async (request) => paginate(db, {
    count: 'SELECT count(*)::int AS total FROM conversations WHERE user_id=$1',
    list: `SELECT c.id,c.title,c.completed,c.created_at AS "createdAt",c.updated_at AS "updatedAt",(SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id) AS "messageCount" FROM conversations c WHERE c.user_id=$1 ORDER BY c.updated_at DESC, c.id`,
    values: [request.user.id], page: request.query.page
  }));
  app.post('/api/conversations', { onRequest: requireUser }, async (request) => {
    const result = await db.query(`INSERT INTO conversations (id,user_id) VALUES ($1,$2) RETURNING ${CONVERSATION_COLUMNS}`, [randomUUID(), request.user.id]);
    return { conversation: { ...result.rows[0], messages: [] } };
  });
  app.get('/api/conversations/:id', { onRequest: requireUser, schema: { params: idParams } }, async (request) => ({ conversation: await loadConversation(request.params.id, request.user.id) }));
  app.post('/api/conversations/:id', { onRequest: requireUser, schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 70, pattern: '\\S' }, completed: { type: 'boolean' } } } } }, async (request) => {
    const { title, completed } = request.body;
    const result = await db.query('UPDATE conversations SET title=COALESCE($1,title),completed=COALESCE($2,completed),updated_at=now() WHERE id=$3 AND user_id=$4', [title?.trim() ?? null, completed ?? null, request.params.id, request.user.id]);
    if (!result.rowCount) throw httpError(404, 'NOT_FOUND', 'Conversation not found.');
    return { conversation: await loadConversation(request.params.id, request.user.id) };
  });
  app.delete('/api/conversations/:id', { onRequest: requireUser, schema: { params: idParams } }, async (request) => {
    const result = await db.query('DELETE FROM conversations WHERE id=$1 AND user_id=$2', [request.params.id, request.user.id]);
    if (!result.rowCount) throw httpError(404, 'NOT_FOUND', 'Conversation not found.');
    return { ok: true };
  });

  // Without a conversation this is the stateless legacy assistant, which needs no account.
  app.post('/api/chat', { schema: { body: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: text, conversationId: { type: 'string', format: 'uuid' }, requestId } } } }, async (request, reply) => {
    const { message, conversationId } = request.body;
    if (!conversationId) return { reply: getReply(message.trim()) };
    await requireUser(request, reply);
    if (reply.sent) return reply;
    if (!request.body.requestId) throw httpError(400, 'VALIDATION_ERROR', 'A request id is required.');
    return exchange(request.user, conversationId, request.body.requestId, async () => {
      const content = message.trim();
      const known = (await db.query('SELECT answer FROM knowledge WHERE question_key=$1', [normalize(content)])).rows[0];
      if (known) return { intent: 'knowledge', message: content, reply: { content: known.answer } };
      const intent = classify(content);
      const action = SERVICES.includes(intent) ? intent : undefined;
      return { intent, message: content, reply: { content: replies[intent] || replies.service, action } };
    });
  });
  app.post('/api/services/:service', { onRequest: requireUser, schema: { params: { type: 'object', required: ['service'], properties: { service: { enum: SERVICES } } }, body: { type: 'object', additionalProperties: false, required: ['conversationId', 'requestId'], properties: { conversationId: { type: 'string', format: 'uuid' }, requestId, input: { type: 'object' } } } } }, async (request) => {
    const intent = request.params.service;
    return exchange(request.user, request.body.conversationId, request.body.requestId, async () => {
      let service;
      try { service = await runService(intent, request.body.input || {}); }
      catch (error) { throw httpError(error.statusCode || 400, 'SERVICE_ERROR', error.message); }
      const message = service.input.model ? `${service.input.model} · ${service.input.registration} · ${service.input.engine} cc · ${service.input.fuel}` : service.input.reference;
      return { intent, message, reply: { content: service.title, result: service, service: intent } };
    });
  });

  app.get('/api/quotes', { onRequest: requireUser, schema: { querystring: pageQuery('page') } }, async (request) => paginate(db, {
    count: 'SELECT count(*)::int AS total FROM saved_quotes WHERE user_id=$1',
    list: 'SELECT id,message_id AS "messageId",result,saved_at AS "savedAt" FROM saved_quotes WHERE user_id=$1 ORDER BY saved_at DESC, id',
    values: [request.user.id], page: request.query.page
  }));
  app.post('/api/quotes', { onRequest: requireUser, schema: { body: { type: 'object', additionalProperties: false, required: ['conversationId', 'messageId'], properties: { conversationId: { type: 'string', format: 'uuid' }, messageId: { type: 'string', format: 'uuid' } } } } }, async (request) => {
    const { conversationId, messageId } = request.body;
    const found = await db.query(
      `SELECT m.result FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE m.id=$1 AND c.id=$2 AND c.user_id=$3 AND m.service IN ('quote','advisor') AND m.result IS NOT NULL`,
      [messageId, conversationId, request.user.id]
    );
    if (!found.rowCount) throw httpError(404, 'NOT_FOUND', 'Estimate not found.');
    await db.query('INSERT INTO saved_quotes (id,user_id,message_id,result) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (user_id,message_id) DO NOTHING', [randomUUID(), request.user.id, messageId, JSON.stringify(found.rows[0].result)]);
    const quote = await db.query('SELECT id,message_id AS "messageId",result,saved_at AS "savedAt" FROM saved_quotes WHERE user_id=$1 AND message_id=$2', [request.user.id, messageId]);
    return { quote: quote.rows[0] };
  });
  app.delete('/api/quotes/:id', { onRequest: requireUser, schema: { params: idParams } }, async (request) => {
    const result = await db.query('DELETE FROM saved_quotes WHERE id=$1 AND user_id=$2', [request.params.id, request.user.id]);
    if (!result.rowCount) throw httpError(404, 'NOT_FOUND', 'Saved estimate not found.');
    return { ok: true };
  });

  app.get('/api/knowledge', { onRequest: requireUser }, async () => {
    const result = await db.query('SELECT id,question,answer,updated_at AS "updatedAt" FROM knowledge ORDER BY created_at, id');
    return { knowledge: result.rows };
  });
  app.post('/api/activity', { onRequest: requireUser, schema: { body: { type: 'object', additionalProperties: false, required: ['intent', 'message'], properties: { intent: { enum: INTENTS }, message: text } } } }, async (request) => {
    await withTransaction(db, (client) => recordQuery(client, { userId: request.user.id, intent: request.body.intent, message: request.body.message.trim() }));
    return { ok: true };
  });
}

module.exports = { registerAssistantRoutes };
