'use strict';
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const rateLimit = require('@fastify/rate-limit');
const fastifyStatic = require('@fastify/static');
const config = require('./src/config');
const { getPool } = require('./src/database/pool');
const auth = require('./src/services/auth');
const { recordAudit } = require('./src/services/audit');
const { getReply } = require('./chatbot');

const demoState = { queries: [], unresolved: [], knowledge: [], models: {} };
const normalized = (text) => text.toLowerCase().replace(/[?!.,]/g, '').replace(/\s+/g, ' ').trim();
const userView = (user) => ({ id: user.id, name: user.name, email: user.email, role: user.role });
const errorPayload = (code, message, details) => ({ error: { code, message, ...(details ? { details } : {}) } });
const vehicleFields = {
  make: 'make', model: 'model', year: 'year', engineCapacityCc: 'engine_capacity_cc', fuelType: 'fuel_type',
  originCountry: 'origin_country', vin: 'vin'
};

function buildApp(options = {}) {
  const db = options.db || getPool();
  const settings = { ...config, ...options.config };
  const app = Fastify({
    logger: { level: settings.logLevel || 'info', redact: ['req.headers.cookie', 'req.body.password'] },
    trustProxy: settings.trustProxy,
    bodyLimit: 32 * 1024
  });
  app.decorateRequest('user', null);
  app.register(cookie);
  app.register(rateLimit, { global: true, max: 200, timeWindow: '15 minutes' });
  app.register(fastifyStatic, { root: path.join(__dirname, 'public'), prefix: '/' });

  app.setErrorHandler((error, request, reply) => {
    if (error.validation) return reply.code(400).send(errorPayload('VALIDATION_ERROR', 'Please check the submitted information.', error.validation.map((item) => ({ field: item.instancePath || item.params?.missingProperty, message: item.message }))));
    if (error.statusCode === 429) return reply.code(429).send(errorPayload('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
    if (error.code === '23505') return reply.code(409).send(errorPayload('CONFLICT', 'A record with these details already exists.'));
    if (error.code === '23503') return reply.code(400).send(errorPayload('INVALID_REFERENCE', 'The related record is unavailable.'));
    if (error.code === '23514') return reply.code(400).send(errorPayload('INVALID_INPUT', 'Please check the submitted information.'));
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send(errorPayload('REQUEST_ERROR', error.message));
    request.log.error({ errorCode: error.code || error.name, requestId: request.id }, 'Request failed');
    return reply.code(500).send(errorPayload('INTERNAL_ERROR', 'The request could not be completed.'));
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(errorPayload('NOT_FOUND', 'The requested endpoint was not found.')));

  async function requireUser(request, reply) {
    const token = request.cookies.portside_session;
    const user = await auth.findSession(db, token);
    if (!user) return reply.code(401).send(errorPayload('UNAUTHENTICATED', 'Please sign in.'));
    request.user = user;
  }
  async function requireAdmin(request, reply) {
    if (request.user?.role !== 'admin') return reply.code(403).send(errorPayload('FORBIDDEN', 'Administrator access is required.'));
  }
  async function requireCustomer(request, reply) {
    if (request.user?.role !== 'customer') return reply.code(403).send(errorPayload('FORBIDDEN', 'A customer account is required.'));
  }
  const loginSchema = {
    body: { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: {
      email: { type: 'string', format: 'email', maxLength: 254 }, password: { type: 'string', minLength: 1, maxLength: 256 }
    } }
  };
  const registrationSchema = {
    body: { type: 'object', additionalProperties: false, required: ['name', 'email', 'password'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
      email: { type: 'string', format: 'email', maxLength: 254 },
      password: { type: 'string', minLength: 12, maxLength: 256 }
    } }
  };
  const userSession = async (request) => auth.findSession(db, request.cookies.portside_session);
  const loginHandler = async (request, reply) => {
    const user = await auth.authenticate(db, request.body.email, request.body.password);
    if (!user) return reply.code(401).send(errorPayload('INVALID_CREDENTIALS', 'Email or password is incorrect.'));
    const session = await auth.createSession(db, user.id, settings.sessionTtlHours);
    reply.setCookie('portside_session', session.token, {
      httpOnly: true, sameSite: 'strict', secure: Boolean(settings.cookieSecure), path: '/', expires: session.expiresAt
    });
    await recordAudit(db, { actorId: user.id, action: 'auth.login', recordType: 'session' });
    return { user: userView(user) };
  };
  app.post('/api/auth/login', { ...loginSchema, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, loginHandler);
  app.post('/api/auth/register', { ...registrationSchema, config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const user = await auth.createUser(db, { ...request.body, role: 'customer' });
    const session = await auth.createSession(db, user.id, settings.sessionTtlHours);
    reply.setCookie('portside_session', session.token, {
      httpOnly: true, sameSite: 'strict', secure: Boolean(settings.cookieSecure), path: '/', expires: session.expiresAt
    });
    await recordAudit(db, { actorId: user.id, action: 'auth.register', recordType: 'user', recordId: user.id });
    return reply.code(201).send({ user: userView(user) });
  });
  // Compatibility endpoint accepts the old username field but never exposes the old demo accounts.
  app.post('/api/login', { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: { type: 'string', maxLength: 254 }, password: { type: 'string', minLength: 1, maxLength: 256 } } }, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => loginHandler({ body: { email: request.body.username, password: request.body.password } }, reply));
  const logoutHandler = async (request, reply) => {
    const user = await userSession(request);
    await auth.deleteSession(db, request.cookies.portside_session);
    if (user) await recordAudit(db, { actorId: user.id, action: 'auth.logout', recordType: 'session' });
    reply.clearCookie('portside_session', { path: '/', httpOnly: true, sameSite: 'strict', secure: Boolean(settings.cookieSecure) });
    return { ok: true };
  };
  app.post('/api/auth/logout', logoutHandler);
  app.post('/api/logout', logoutHandler);
  const meHandler = async (request, reply) => {
    const user = await userSession(request);
    if (!user) return reply.code(401).send(errorPayload('UNAUTHENTICATED', 'Please sign in.'));
    return { user: userView(user) };
  };
  app.get('/api/auth/me', meHandler);
  app.get('/api/session', meHandler);

  app.get('/api/vehicles', { preHandler: [requireUser, requireCustomer] }, async (request) => {
    const result = await db.query('SELECT id,make,model,year,engine_capacity_cc AS "engineCapacityCc",fuel_type AS "fuelType",origin_country AS "originCountry",vin,created_at,updated_at FROM vehicles WHERE customer_id=$1 ORDER BY created_at DESC', [request.user.id]);
    return { vehicles: result.rows };
  });
  const vehicleBody = {
    type: 'object', additionalProperties: false, required: ['make', 'model'], properties: {
      make: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' }, model: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
      year: { type: 'integer', minimum: 1900, maximum: 2100 }, engineCapacityCc: { type: 'integer', minimum: 1, maximum: 20000 },
      fuelType: { type: 'string', maxLength: 40 }, originCountry: { type: 'string', maxLength: 80 }, vin: { type: 'string', maxLength: 40 }
    }
  };
  const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
  app.post('/api/vehicles', { preHandler: [requireUser, requireCustomer], schema: { body: vehicleBody } }, async (request, reply) => {
    const id = randomUUID();
    const b = request.body;
    const result = await db.query(
      'INSERT INTO vehicles (id,customer_id,make,model,year,engine_capacity_cc,fuel_type,origin_country,vin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,make,model,year,engine_capacity_cc AS "engineCapacityCc",fuel_type AS "fuelType",origin_country AS "originCountry",vin,created_at,updated_at',
      [id, request.user.id, b.make.trim(), b.model.trim(), b.year ?? null, b.engineCapacityCc ?? null, b.fuelType?.trim() || null, b.originCountry?.trim() || null, b.vin?.trim().toUpperCase() || null]
    );
    await recordAudit(db, { actorId: request.user.id, action: 'vehicle.create', recordType: 'vehicle', recordId: id });
    return reply.code(201).send({ vehicle: result.rows[0] });
  });
  app.get('/api/vehicles/:id', { preHandler: [requireUser, requireCustomer], schema: { params: idParams } }, async (request, reply) => {
    const result = await db.query('SELECT id,make,model,year,engine_capacity_cc AS "engineCapacityCc",fuel_type AS "fuelType",origin_country AS "originCountry",vin,created_at,updated_at FROM vehicles WHERE id=$1 AND customer_id=$2', [request.params.id, request.user.id]);
    if (!result.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Vehicle not found.'));
    return { vehicle: result.rows[0] };
  });
  const patchFields = Object.keys(vehicleFields);
  const vehiclePatch = { ...vehicleBody, required: [], minProperties: 1 };
  app.patch('/api/vehicles/:id', { preHandler: [requireUser, requireCustomer], schema: { params: idParams, body: vehiclePatch } }, async (request, reply) => {
    const keys = Object.keys(request.body).filter((key) => patchFields.includes(key));
    const assignments = keys.map((key, index) => `${vehicleFields[key]}=$${index + 1}`);
    const values = keys.map((key) => ['make', 'model', 'fuelType', 'originCountry', 'vin'].includes(key) ? (request.body[key]?.trim() || null) : request.body[key]);
    const idx = values.length;
    const result = await db.query(`UPDATE vehicles SET ${assignments.join(',')},updated_at=now() WHERE id=$${idx + 1} AND customer_id=$${idx + 2} RETURNING id,make,model,year,engine_capacity_cc AS "engineCapacityCc",fuel_type AS "fuelType",origin_country AS "originCountry",vin,created_at,updated_at`, [...values, request.params.id, request.user.id]);
    if (!result.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Vehicle not found.'));
    await recordAudit(db, { actorId: request.user.id, action: 'vehicle.update', recordType: 'vehicle', recordId: request.params.id });
    return { vehicle: result.rows[0] };
  });

  app.get('/api/enquiries', { preHandler: [requireUser, requireCustomer] }, async (request) => {
    const result = await db.query('SELECT id,reference,vehicle_id AS "vehicleId",category,description,status,priority,created_at,updated_at FROM enquiries WHERE customer_id=$1 ORDER BY created_at DESC', [request.user.id]);
    return { enquiries: result.rows };
  });
  app.post('/api/enquiries', { preHandler: [requireUser, requireCustomer], schema: { body: { type: 'object', additionalProperties: false, required: ['category', 'description'], properties: { category: { type: 'string', minLength: 1, maxLength: 80 }, description: { type: 'string', minLength: 1, maxLength: 4000 }, vehicleId: { type: 'string', format: 'uuid' } } } } }, async (request, reply) => {
    const { category, description, vehicleId } = request.body;
    if (vehicleId) {
      const owned = await db.query('SELECT 1 FROM vehicles WHERE id=$1 AND customer_id=$2', [vehicleId, request.user.id]);
      if (!owned.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Vehicle not found.'));
    }
    const id = randomUUID();
    const reference = `PST-${new Date().getUTCFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`;
    const result = await db.query('INSERT INTO enquiries (id,reference,customer_id,vehicle_id,category,description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,reference,vehicle_id AS "vehicleId",category,description,status,priority,created_at,updated_at', [id, reference, request.user.id, vehicleId || null, category.trim(), description.trim()]);
    await recordAudit(db, { actorId: request.user.id, action: 'enquiry.create', recordType: 'enquiry', recordId: id });
    return reply.code(201).send({ enquiry: result.rows[0] });
  });
  app.get('/api/enquiries/:id', { preHandler: [requireUser, requireCustomer], schema: { params: idParams } }, async (request, reply) => {
    const result = await db.query('SELECT id,reference,vehicle_id AS "vehicleId",category,description,status,priority,created_at,updated_at FROM enquiries WHERE id=$1 AND customer_id=$2', [request.params.id, request.user.id]);
    if (!result.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Enquiry not found.'));
    return { enquiry: result.rows[0] };
  });
  app.get('/api/admin/enquiries', { preHandler: [requireUser, requireAdmin] }, async () => {
    const result = await db.query('SELECT e.id,e.reference,e.customer_id AS "customerId",u.name AS "customerName",u.email AS "customerEmail",e.vehicle_id AS "vehicleId",e.category,e.description,e.status,e.priority,e.created_at,e.updated_at FROM enquiries e JOIN users u ON u.id=e.customer_id ORDER BY e.created_at DESC');
    return { enquiries: result.rows };
  });
  app.patch('/api/admin/enquiries/:id', { preHandler: [requireUser, requireAdmin], schema: { params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { status: { enum: ['new', 'in_review', 'waiting_on_customer', 'resolved', 'closed'] }, priority: { enum: ['low', 'normal', 'high', 'urgent'] } } } } }, async (request, reply) => {
    const keys = Object.keys(request.body);
    const sets = keys.map((key, index) => `${key}=$${index + 1}`);
    const result = await db.query(`UPDATE enquiries SET ${sets.join(',')},updated_at=now() WHERE id=$${keys.length + 1} RETURNING id,reference,status,priority,updated_at`, [...keys.map((key) => request.body[key]), request.params.id]);
    if (!result.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Enquiry not found.'));
    await recordAudit(db, { actorId: request.user.id, action: 'enquiry.admin_update', recordType: 'enquiry', recordId: request.params.id, metadata: request.body });
    return { enquiry: result.rows[0] };
  });

  // Existing demo-only assistant and dashboard data remains available to preserve the prototype UI.
  app.get('/api/admin', { preHandler: [requireUser, requireAdmin] }, async () => demoState);
  app.get('/api/knowledge', { preHandler: requireUser }, async () => ({ knowledge: demoState.knowledge }));
  app.post('/api/activity', { preHandler: requireUser, schema: { body: { type: 'object', additionalProperties: false, properties: { model: { type: 'string', maxLength: 80 }, intent: { type: 'string', enum: ['quote', 'advisor', 'vin', 'tracking', 'help', 'knowledge', 'unresolved'] }, message: { type: 'string', minLength: 1, maxLength: 1000 } }, anyOf: [{ required: ['model'] }, { required: ['intent', 'message'] }] } } }, async (request) => {
    const data = request.body;
    if (data.model) {
      if (!['Toyota Harrier', 'Toyota Prado', 'Mazda CX-5', 'Nissan X-Trail'].includes(data.model)) throw Object.assign(new Error('Invalid model.'), { statusCode: 400 });
      demoState.models[data.model] = (demoState.models[data.model] || 0) + 1;
    } else {
      demoState.queries.push({ intent: data.intent, message: data.message, username: request.user.email, at: new Date().toISOString() });
      if (data.intent === 'unresolved' && !demoState.unresolved.some((item) => normalized(item.question) === normalized(data.message))) demoState.unresolved.push({ id: randomUUID(), question: data.message });
    }
    return { ok: true };
  });
  app.post('/api/answers', { preHandler: [requireUser, requireAdmin], schema: { body: { type: 'object', additionalProperties: false, required: ['id', 'answer'], properties: { id: { type: 'string', format: 'uuid' }, answer: { type: 'string', minLength: 1, maxLength: 2000 } } } } }, async (request, reply) => {
    const question = demoState.unresolved.find((item) => item.id === request.body.id);
    if (!question) return reply.code(404).send(errorPayload('NOT_FOUND', 'Question unavailable.'));
    demoState.knowledge.push({ question: question.question, answer: request.body.answer.trim() });
    demoState.unresolved = demoState.unresolved.filter((item) => item.id !== request.body.id);
    return { ok: true };
  });
  app.post('/api/chat', { schema: { body: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: 1000 } } } } }, async (request) => ({ reply: getReply(request.body.message.trim()) }));
  app.get('/health', async (request, reply) => {
    try { await db.query('SELECT 1'); return { status: 'ok', database: 'ok' }; }
    catch { return reply.code(503).send({ status: 'unavailable', database: 'unavailable' }); }
  });
  return app;
}

if (require.main === module) {
  try {
    const app = buildApp();
    app.listen({ port: config.port, host: config.host }).then(() => {
      app.log.info(`Portside is running at http://${config.host}:${config.port}`);
    }).catch((error) => { app.log.error({ errorCode: error.code || error.name }, 'Server could not start'); process.exitCode = 1; });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildApp, demoState };
