'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const { recordAudit } = require('../services/audit');
const { errorPayload, idParams } = require('../http');

const vehicleFields = {
  make: 'make', model: 'model', year: 'year', engineCapacityCc: 'engine_capacity_cc', fuelType: 'fuel_type',
  originCountry: 'origin_country', vin: 'vin'
};

function registerRecordRoutes(app, { db, requireUser, requireAdmin, requireCustomer }) {
  app.get('/api/vehicles', { onRequest: [requireUser, requireCustomer] }, async (request) => {
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
  app.post('/api/vehicles', { onRequest: [requireUser, requireCustomer], schema: { body: vehicleBody } }, async (request, reply) => {
    const id = randomUUID();
    const b = request.body;
    const result = await db.query(
      'INSERT INTO vehicles (id,customer_id,make,model,year,engine_capacity_cc,fuel_type,origin_country,vin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,make,model,year,engine_capacity_cc AS "engineCapacityCc",fuel_type AS "fuelType",origin_country AS "originCountry",vin,created_at,updated_at',
      [id, request.user.id, b.make.trim(), b.model.trim(), b.year ?? null, b.engineCapacityCc ?? null, b.fuelType?.trim() || null, b.originCountry?.trim() || null, b.vin?.trim().toUpperCase() || null]
    );
    await recordAudit(db, { actorId: request.user.id, action: 'vehicle.create', recordType: 'vehicle', recordId: id });
    return reply.code(201).send({ vehicle: result.rows[0] });
  });
  app.get('/api/vehicles/:id', { onRequest: [requireUser, requireCustomer], schema: { params: idParams } }, async (request, reply) => {
    const result = await db.query('SELECT id,make,model,year,engine_capacity_cc AS "engineCapacityCc",fuel_type AS "fuelType",origin_country AS "originCountry",vin,created_at,updated_at FROM vehicles WHERE id=$1 AND customer_id=$2', [request.params.id, request.user.id]);
    if (!result.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Vehicle not found.'));
    return { vehicle: result.rows[0] };
  });
  const patchFields = Object.keys(vehicleFields);
  const vehiclePatch = { ...vehicleBody, required: [], minProperties: 1 };
  app.patch('/api/vehicles/:id', { onRequest: [requireUser, requireCustomer], schema: { params: idParams, body: vehiclePatch } }, async (request, reply) => {
    const keys = Object.keys(request.body).filter((key) => patchFields.includes(key));
    const assignments = keys.map((key, index) => `${vehicleFields[key]}=$${index + 1}`);
    const values = keys.map((key) => ['make', 'model', 'fuelType', 'originCountry', 'vin'].includes(key) ? (request.body[key]?.trim() || null) : request.body[key]);
    const idx = values.length;
    const result = await db.query(`UPDATE vehicles SET ${assignments.join(',')},updated_at=now() WHERE id=$${idx + 1} AND customer_id=$${idx + 2} RETURNING id,make,model,year,engine_capacity_cc AS "engineCapacityCc",fuel_type AS "fuelType",origin_country AS "originCountry",vin,created_at,updated_at`, [...values, request.params.id, request.user.id]);
    if (!result.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Vehicle not found.'));
    await recordAudit(db, { actorId: request.user.id, action: 'vehicle.update', recordType: 'vehicle', recordId: request.params.id });
    return { vehicle: result.rows[0] };
  });

  app.get('/api/enquiries', { onRequest: [requireUser, requireCustomer] }, async (request) => {
    const result = await db.query('SELECT id,reference,vehicle_id AS "vehicleId",category,description,status,priority,created_at,updated_at FROM enquiries WHERE customer_id=$1 ORDER BY created_at DESC', [request.user.id]);
    return { enquiries: result.rows };
  });
  app.post('/api/enquiries', { onRequest: [requireUser, requireCustomer], schema: { body: { type: 'object', additionalProperties: false, required: ['category', 'description'], properties: { category: { type: 'string', minLength: 1, maxLength: 80 }, description: { type: 'string', minLength: 1, maxLength: 4000 }, vehicleId: { type: 'string', format: 'uuid' } } } } }, async (request, reply) => {
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
  app.get('/api/enquiries/:id', { onRequest: [requireUser, requireCustomer], schema: { params: idParams } }, async (request, reply) => {
    const result = await db.query('SELECT id,reference,vehicle_id AS "vehicleId",category,description,status,priority,created_at,updated_at FROM enquiries WHERE id=$1 AND customer_id=$2', [request.params.id, request.user.id]);
    if (!result.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Enquiry not found.'));
    return { enquiry: result.rows[0] };
  });
  app.get('/api/admin/enquiries', { onRequest: [requireUser, requireAdmin] }, async () => {
    const result = await db.query('SELECT e.id,e.reference,e.customer_id AS "customerId",u.name AS "customerName",u.email AS "customerEmail",e.vehicle_id AS "vehicleId",e.category,e.description,e.status,e.priority,e.created_at,e.updated_at FROM enquiries e JOIN users u ON u.id=e.customer_id ORDER BY e.created_at DESC');
    return { enquiries: result.rows };
  });
  app.patch('/api/admin/enquiries/:id', { onRequest: [requireUser, requireAdmin], schema: { params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { status: { enum: ['new', 'in_review', 'waiting_on_customer', 'resolved', 'closed'] }, priority: { enum: ['low', 'normal', 'high', 'urgent'] } } } } }, async (request, reply) => {
    const keys = Object.keys(request.body);
    const sets = keys.map((key, index) => `${key}=$${index + 1}`);
    const result = await db.query(`UPDATE enquiries SET ${sets.join(',')},updated_at=now() WHERE id=$${keys.length + 1} RETURNING id,reference,status,priority,updated_at`, [...keys.map((key) => request.body[key]), request.params.id]);
    if (!result.rowCount) return reply.code(404).send(errorPayload('NOT_FOUND', 'Enquiry not found.'));
    await recordAudit(db, { actorId: request.user.id, action: 'enquiry.admin_update', recordType: 'enquiry', recordId: request.params.id, metadata: request.body });
    return { enquiry: result.rows[0] };
  });

}

module.exports = { registerRecordRoutes };
