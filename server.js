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
const { lookupVehicle, VehicleLookupError } = require('./src/services/vehicle-lookup');
const { calculateImportEstimate, ImportEstimateError } = require('./src/services/import-cost-estimator');
const { STATUS_LIFECYCLE, ShipmentInputError, cleanOptional, validateCreateShipment, validateShipmentPatch, validateOccurredAt, nextStatus } = require('./src/services/shipments');
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
  app.post('/api/vehicle-lookup', {
    preHandler: [requireUser],
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['identifier'], properties: { identifier: { type: 'string', minLength: 1, maxLength: 40 } } } }
  }, async (request, reply) => {
    try {
      return await lookupVehicle(request.body.identifier, {
        provider: options.vehicleProvider,
        timeoutMs: settings.vehicleLookupTimeoutMs
      });
    } catch (error) {
      if (error instanceof VehicleLookupError) return reply.code(error.statusCode).send({ status: 'error', error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.post('/api/import-cost-estimate', {
    preHandler: [requireUser, requireCustomer],
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: { body: {
      type: 'object', additionalProperties: false,
      required: ['make', 'model', 'year', 'fuelType', 'purchasePrice', 'currency', 'countryOfExport'],
      properties: {
        make: { type: 'string', minLength: 1, maxLength: 80 }, model: { type: 'string', minLength: 1, maxLength: 100 },
        year: { type: 'integer', minimum: 1886, maximum: 2100 }, engineCapacityCc: { type: 'integer', minimum: 1, maximum: 20000 },
        fuelType: { type: 'string', minLength: 1, maxLength: 20 }, purchasePrice: { type: 'number', minimum: 0 },
        currency: { type: 'string', minLength: 3, maxLength: 3 }, countryOfExport: { type: 'string', minLength: 1, maxLength: 80 },
        freightCost: { type: 'number', minimum: 0 }, insuranceCost: { type: 'number', minimum: 0 },
        exchangeRate: { type: 'number', exclusiveMinimum: 0 }, exchangeRateDate: { type: 'string', maxLength: 10 },
        exchangeRateSource: { type: 'string', maxLength: 200 }, customsValueKsh: { type: 'number', exclusiveMinimum: 0 }
      }
    } }
  }, async (request, reply) => {
    try { return calculateImportEstimate(request.body, options.importCostRules); }
    catch (error) {
      if (error instanceof ImportEstimateError) return reply.code(400).send(errorPayload('INVALID_ESTIMATE_INPUT', error.message));
      throw error;
    }
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

  const shipmentParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
  const shipmentListSchema = { type: 'object', additionalProperties: false };
  async function shipmentsWithMilestones(rows, includeActor = false) {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const events = await db.query('SELECT id,shipment_id AS "shipmentId",status,occurred_at AS "occurredAt",note,source,actor_id AS "actorId",created_at AS "createdAt" FROM shipment_milestones WHERE shipment_id = ANY($1::uuid[]) ORDER BY occurred_at ASC,created_at ASC', [ids]);
    const byShipment = new Map(ids.map((id) => [id, []]));
    for (const event of events.rows) {
      if (!includeActor) delete event.actorId;
      byShipment.get(event.shipmentId)?.push(event);
    }
    return rows.map((row) => ({ ...row, milestones: byShipment.get(row.id) || [] }));
  }
  async function transaction(work) {
    const client = typeof db.connect === 'function' ? await db.connect() : db;
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    } finally { if (client !== db) client.release(); }
  }
  const shipmentSelect = 'SELECT id,tracking_reference AS "trackingReference",customer_id AS "customerId",vehicle_id AS "vehicleId",enquiry_id AS "enquiryId",carrier,origin_port AS "originPort",destination_port AS "destinationPort",status,departure_date AS "departureDate",estimated_arrival_date AS "estimatedArrivalDate",created_at AS "createdAt",updated_at AS "updatedAt" FROM shipments';
  app.get('/api/shipments', { preHandler: [requireUser, requireCustomer] }, async (request) => {
    const result = await db.query(`${shipmentSelect} WHERE customer_id=$1 ORDER BY created_at DESC`, [request.user.id]);
    return { shipments: await shipmentsWithMilestones(result.rows) };
  });
  app.get('/api/shipments/:reference', {
    preHandler: [requireUser, requireCustomer],
    schema: { params: { type: 'object', required: ['reference'], properties: { reference: { type: 'string', minLength: 8, maxLength: 40, pattern: '^[A-Za-z0-9-]+$' } } } }
  }, async (request, reply) => {
    const result = await db.query(`${shipmentSelect} WHERE customer_id=$1 AND tracking_reference=$2`, [request.user.id, request.params.reference.toUpperCase()]);
    if (!result.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Shipment not found.'));
    return { shipment: (await shipmentsWithMilestones(result.rows))[0] };
  });
  app.get('/api/admin/customers', { preHandler: [requireUser, requireAdmin] }, async () => {
    const result = await db.query("SELECT id,name,email FROM users WHERE role='customer' AND status='active' ORDER BY name,email");
    return { customers: result.rows };
  });
  app.get('/api/admin/accounts', { preHandler: [requireUser, requireAdmin] }, async () => {
    const [accounts, activity] = await Promise.all([
      db.query(`SELECT u.id,u.name,u.email,u.status,u.created_at AS "createdAt",
                       MAX(a.created_at) FILTER (WHERE a.action='auth.login') AS "lastLoginAt"
                  FROM users u
                  LEFT JOIN audit_events a ON a.actor_id=u.id AND a.action='auth.login'
                 WHERE u.role='customer'
                 GROUP BY u.id
                 ORDER BY u.created_at DESC`),
      db.query(`SELECT a.action,a.created_at AS "createdAt",
                       u.id AS "userId",u.name AS "userName",u.email AS "userEmail"
                  FROM audit_events a
                  JOIN users u ON u.id=a.actor_id
                 WHERE a.action IN ('auth.login','auth.register')
                 ORDER BY a.created_at DESC
                 LIMIT 100`)
    ]);
    return { accounts: accounts.rows, activity: activity.rows };
  });
  app.get('/api/admin/customers/:id/records', { preHandler: [requireUser, requireAdmin], schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (request, reply) => {
    const customer = await db.query("SELECT id FROM users WHERE id=$1 AND role='customer' AND status='active'", [request.params.id]);
    if (!customer.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Customer not found.'));
    const [vehicles, enquiries] = await Promise.all([
      db.query('SELECT id,make,model,year FROM vehicles WHERE customer_id=$1 ORDER BY created_at DESC', [request.params.id]),
      db.query('SELECT id,reference,category,status FROM enquiries WHERE customer_id=$1 ORDER BY created_at DESC', [request.params.id])
    ]);
    return { vehicles: vehicles.rows, enquiries: enquiries.rows };
  });
  app.get('/api/admin/shipments', { preHandler: [requireUser, requireAdmin] }, async () => {
    const result = await db.query('SELECT s.id,s.tracking_reference AS "trackingReference",s.customer_id AS "customerId",s.vehicle_id AS "vehicleId",s.enquiry_id AS "enquiryId",s.carrier,s.origin_port AS "originPort",s.destination_port AS "destinationPort",s.status,s.departure_date AS "departureDate",s.estimated_arrival_date AS "estimatedArrivalDate",s.created_at AS "createdAt",s.updated_at AS "updatedAt",u.name AS "customerName",u.email AS "customerEmail" FROM shipments s JOIN users u ON u.id=s.customer_id ORDER BY s.created_at DESC');
    return { shipments: await shipmentsWithMilestones(result.rows, true) };
  });
  app.post('/api/admin/shipments', {
    preHandler: [requireUser, requireAdmin],
    schema: { body: { type: 'object', additionalProperties: false, required: ['customerId','originPort','destinationPort'], properties: {
      customerId: { type: 'string', format: 'uuid' }, vehicleId: { type: 'string', format: 'uuid' }, enquiryId: { type: 'string', format: 'uuid' },
      carrier: { type: 'string', maxLength: 120 }, originPort: { type: 'string', minLength: 1, maxLength: 120 }, destinationPort: { type: 'string', minLength: 1, maxLength: 120 },
      departureDate: { type: ['string','null'], maxLength: 10 }, estimatedArrivalDate: { type: ['string','null'], maxLength: 10 }, status: { enum: STATUS_LIFECYCLE }
    } } }
  }, async (request, reply) => {
    try {
      const input = validateCreateShipment(request.body);
      const result = await transaction(async (client) => {
        const customer = await client.query("SELECT id FROM users WHERE id=$1 AND role='customer' AND status='active'", [input.customerId]);
        if (!customer.rowCount) throw Object.assign(new Error('Customer account not found.'), { statusCode: 404 });
        if (input.vehicleId) {
          const vehicle = await client.query('SELECT id FROM vehicles WHERE id=$1 AND customer_id=$2', [input.vehicleId, input.customerId]);
          if (!vehicle.rowCount) throw Object.assign(new Error('Vehicle is not owned by the selected customer.'), { statusCode: 400 });
        }
        if (input.enquiryId) {
          const enquiry = await client.query('SELECT id FROM enquiries WHERE id=$1 AND customer_id=$2', [input.enquiryId, input.customerId]);
          if (!enquiry.rowCount) throw Object.assign(new Error('Enquiry is not owned by the selected customer.'), { statusCode: 400 });
        }
        const id = randomUUID();
        const trackingReference = `PST-SHP-${new Date().getUTCFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`;
        const inserted = await client.query('INSERT INTO shipments (id,tracking_reference,customer_id,vehicle_id,enquiry_id,carrier,origin_port,destination_port,status,departure_date,estimated_arrival_date,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id,tracking_reference AS "trackingReference",customer_id AS "customerId",vehicle_id AS "vehicleId",enquiry_id AS "enquiryId",carrier,origin_port AS "originPort",destination_port AS "destinationPort",status,departure_date AS "departureDate",estimated_arrival_date AS "estimatedArrivalDate",created_at AS "createdAt",updated_at AS "updatedAt"', [id, trackingReference, input.customerId, input.vehicleId, input.enquiryId, input.carrier, input.originPort, input.destinationPort, input.status, input.departureDate, input.estimatedArrivalDate, request.user.id]);
        await client.query('INSERT INTO shipment_milestones (id,shipment_id,status,note,source,actor_id) VALUES ($1,$2,$3,$4,\'manual\',$5)', [randomUUID(), id, input.status, 'Shipment created; initial milestone entered manually by an administrator.', request.user.id]);
        return inserted.rows[0];
      });
      await recordAudit(db, { actorId: request.user.id, action: 'shipment.create', recordType: 'shipment', recordId: result.id });
      return reply.code(201).send({ shipment: result });
    } catch (error) {
      if (error instanceof ShipmentInputError) return reply.code(400).send(errorPayload('INVALID_SHIPMENT', error.message));
      if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send(errorPayload(error.statusCode === 404 ? 'NOT_FOUND' : 'INVALID_REFERENCE', error.message));
      throw error;
    }
  });
  app.patch('/api/admin/shipments/:id', {
    preHandler: [requireUser, requireAdmin], schema: { params: shipmentParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      carrier: { type: ['string','null'], maxLength: 120 }, originPort: { type: 'string', maxLength: 120 }, destinationPort: { type: 'string', maxLength: 120 },
      departureDate: { type: ['string','null'], maxLength: 10 }, estimatedArrivalDate: { type: ['string','null'], maxLength: 10 }
    } } }
  }, async (request, reply) => {
    try {
      const changes = validateShipmentPatch(request.body);
      const result = await transaction(async (client) => {
        const current = await client.query(`${shipmentSelect} WHERE id=$1 FOR UPDATE`, [request.params.id]);
        if (!current.rowCount) return null;
        const shipment = current.rows[0];
        const next = { ...shipment, ...changes };
        if (next.departureDate && next.estimatedArrivalDate && String(next.departureDate).slice(0,10) > String(next.estimatedArrivalDate).slice(0,10)) throw new ShipmentInputError('Estimated arrival date must be on or after departure date.');
        const columns = { carrier: 'carrier', originPort: 'origin_port', destinationPort: 'destination_port', departureDate: 'departure_date', estimatedArrivalDate: 'estimated_arrival_date' };
        const keys = Object.keys(changes);
        const assignments = keys.map((key, index) => `${columns[key]}=$${index + 1}`);
        const updated = await client.query(`UPDATE shipments SET ${assignments.join(',')},updated_by=$${keys.length + 1},updated_at=now() WHERE id=$${keys.length + 2} RETURNING id,tracking_reference AS "trackingReference",customer_id AS "customerId",vehicle_id AS "vehicleId",enquiry_id AS "enquiryId",carrier,origin_port AS "originPort",destination_port AS "destinationPort",status,departure_date AS "departureDate",estimated_arrival_date AS "estimatedArrivalDate",created_at AS "createdAt",updated_at AS "updatedAt"`, [...keys.map((key) => changes[key]), request.user.id, request.params.id]);
        return updated.rows[0];
      });
      if (!result) return reply.code(404).send(errorPayload('NOT_FOUND', 'Shipment not found.'));
      await recordAudit(db, { actorId: request.user.id, action: 'shipment.update', recordType: 'shipment', recordId: result.id, metadata: changes });
      return { shipment: result };
    } catch (error) {
      if (error instanceof ShipmentInputError) return reply.code(400).send(errorPayload('INVALID_SHIPMENT', error.message));
      throw error;
    }
  });
  app.post('/api/admin/shipments/:id/milestones', {
    preHandler: [requireUser, requireAdmin], schema: { params: shipmentParams, body: { type: 'object', additionalProperties: false, required: ['status'], properties: {
      status: { enum: STATUS_LIFECYCLE }, occurredAt: { type: 'string', maxLength: 40 }, note: { type: 'string', maxLength: 1000 }
    } } }
  }, async (request, reply) => {
    try {
      const occurredAt = validateOccurredAt(request.body.occurredAt);
      const note = cleanOptional(request.body.note, 'Milestone note', 1000);
      const result = await transaction(async (client) => {
        const current = await client.query(`${shipmentSelect} WHERE id=$1 FOR UPDATE`, [request.params.id]);
        if (!current.rowCount) return null;
        const shipment = current.rows[0]; nextStatus(shipment.status, request.body.status);
        const latest = await client.query('SELECT occurred_at AS "occurredAt" FROM shipment_milestones WHERE shipment_id=$1 ORDER BY occurred_at DESC,created_at DESC LIMIT 1', [request.params.id]);
        if (latest.rowCount && occurredAt < new Date(latest.rows[0].occurredAt)) throw new ShipmentInputError('Milestone timestamps must be chronological.');
        const updated = await client.query('UPDATE shipments SET status=$1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING id,tracking_reference AS "trackingReference",customer_id AS "customerId",vehicle_id AS "vehicleId",enquiry_id AS "enquiryId",carrier,origin_port AS "originPort",destination_port AS "destinationPort",status,departure_date AS "departureDate",estimated_arrival_date AS "estimatedArrivalDate",created_at AS "createdAt",updated_at AS "updatedAt"', [request.body.status, request.user.id, request.params.id]);
        const event = await client.query('INSERT INTO shipment_milestones (id,shipment_id,status,occurred_at,note,source,actor_id) VALUES ($1,$2,$3,$4,$5,\'manual\',$6) RETURNING id,shipment_id AS "shipmentId",status,occurred_at AS "occurredAt",note,source,actor_id AS "actorId",created_at AS "createdAt"', [randomUUID(), request.params.id, request.body.status, occurredAt, note, request.user.id]);
        return { shipment: updated.rows[0], milestone: event.rows[0] };
      });
      if (!result) return reply.code(404).send(errorPayload('NOT_FOUND', 'Shipment not found.'));
      await recordAudit(db, { actorId: request.user.id, action: 'shipment.milestone', recordType: 'shipment', recordId: result.shipment.id, metadata: { status: result.milestone.status } });
      return { ...result, milestone: { ...result.milestone, source: 'manual' } };
    } catch (error) {
      if (error instanceof ShipmentInputError) return reply.code(400).send(errorPayload('INVALID_SHIPMENT', error.message));
      throw error;
    }
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
