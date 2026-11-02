'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../server');
const { createSession } = require('../src/services/auth');

class ShipmentTestDatabase {
  constructor() {
    this.users = new Map([
      ['00000000-0000-4000-8000-000000000001', { id: '00000000-0000-4000-8000-000000000001', name: 'Customer One', email: 'one@example.test', role: 'customer', status: 'active' }],
      ['00000000-0000-4000-8000-000000000002', { id: '00000000-0000-4000-8000-000000000002', name: 'Customer Two', email: 'two@example.test', role: 'customer', status: 'active' }],
      ['00000000-0000-4000-8000-000000000003', { id: '00000000-0000-4000-8000-000000000003', name: 'Admin', email: 'admin@example.test', role: 'admin', status: 'active' }]
    ]);
    this.sessions = new Map(); this.shipments = new Map(); this.milestones = []; this.audits = [];
    this.vehicles = new Map([['00000000-0000-4000-8000-000000000011', { id: '00000000-0000-4000-8000-000000000011', customerId: '00000000-0000-4000-8000-000000000001' }]]);
    this.enquiries = new Map([['00000000-0000-4000-8000-000000000021', { id: '00000000-0000-4000-8000-000000000021', customerId: '00000000-0000-4000-8000-000000000001' }]]);
  }
  async connect() { return { query: this.query.bind(this), release() {} }; }
  async query(sql, values = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [], rowCount: 0 };
    if (q === 'DELETE FROM sessions WHERE expires_at <= now()') return { rows: [], rowCount: 0 };
    if (q.startsWith('INSERT INTO sessions')) { this.sessions.set(values[0], { id: values[1], expires: new Date(values[2]) }); return { rows: [], rowCount: 1 }; }
    if (q.startsWith('SELECT u.id,u.name,u.email,u.role,u.status,s.expires_at')) {
      const session = this.sessions.get(values[0]); const user = session && this.users.get(session.id);
      return session && user ? { rows: [{ ...user, expires_at: session.expires }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (q.startsWith('INSERT INTO audit_events')) { this.audits.push(values); return { rows: [], rowCount: 1 }; }
    if (q.startsWith('SELECT id,name,email FROM users')) {
      const rows = [...this.users.values()].filter((user) => user.role === 'customer' && user.status === 'active').map(({ id, name, email }) => ({ id, name, email }));
      return { rows, rowCount: rows.length };
    }
    if (q.startsWith('SELECT id FROM users WHERE id=$1 AND role=')) {
      const user = this.users.get(values[0]); const found = user?.role === 'customer' && user.status === 'active';
      return { rows: found ? [{ id: user.id }] : [], rowCount: found ? 1 : 0 };
    }
    if (q.startsWith('SELECT id FROM vehicles')) { const row = this.vehicles.get(values[0]); const found = row?.customerId === values[1]; return { rows: found ? [{ id: row.id }] : [], rowCount: found ? 1 : 0 }; }
    if (q.startsWith('SELECT id FROM enquiries')) { const row = this.enquiries.get(values[0]); const found = row?.customerId === values[1]; return { rows: found ? [{ id: row.id }] : [], rowCount: found ? 1 : 0 }; }
    if (q.startsWith('SELECT id,make,model,year FROM vehicles WHERE customer_id=$1')) { const rows = [...this.vehicles.values()].filter((row) => row.customerId === values[0]).map((row) => ({ ...row, make: 'Toyota', model: 'Harrier', year: 2020 })); return { rows, rowCount: rows.length }; }
    if (q.startsWith('SELECT id,reference,category,status FROM enquiries WHERE customer_id=$1')) { const rows = [...this.enquiries.values()].filter((row) => row.customerId === values[0]).map((row) => ({ ...row, reference: 'PST-2026-ABCD1234', category: 'Import assistance', status: 'new' })); return { rows, rowCount: rows.length }; }
    if (q.startsWith('INSERT INTO shipments')) {
      const [id, trackingReference, customerId, vehicleId, enquiryId, carrier, originPort, destinationPort, status, departureDate, estimatedArrivalDate, actorId] = values;
      const row = { id, trackingReference, customerId, vehicleId, enquiryId, carrier, originPort, destinationPort, status, departureDate, estimatedArrivalDate, createdBy: actorId, updatedBy: actorId, createdAt: new Date(), updatedAt: new Date() };
      this.shipments.set(id, row); return { rows: [row], rowCount: 1 };
    }
    if (q.startsWith('INSERT INTO shipment_milestones')) {
      const [id, shipmentId, status, occurredAtOrNote, noteOrActor, actorId] = values;
      const hasOccurredAt = q.includes('occurred_at,');
      const event = hasOccurredAt
        ? { id, shipmentId, status, occurredAt: new Date(occurredAtOrNote), note: noteOrActor, source: 'manual', actorId, createdAt: new Date() }
        : { id, shipmentId, status, occurredAt: new Date(), note: occurredAtOrNote, source: 'manual', actorId: noteOrActor, createdAt: new Date() };
      this.milestones.push(event); return { rows: [event], rowCount: 1 };
    }
    if (q.startsWith('SELECT id,tracking_reference AS "trackingReference"') && q.includes('FROM shipments WHERE id=$1 FOR UPDATE')) {
      const row = this.shipments.get(values[0]); return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (q.startsWith('SELECT occurred_at AS "occurredAt" FROM shipment_milestones')) {
      const rows = this.milestones.filter((event) => event.shipmentId === values[0]).sort((a, b) => b.occurredAt - a.occurredAt);
      return { rows: rows.length ? [{ occurredAt: rows[0].occurredAt }] : [], rowCount: rows.length ? 1 : 0 };
    }
    if (q.startsWith('UPDATE shipments SET status=')) {
      const [status, actorId, id] = values; const row = this.shipments.get(id); if (!row) return { rows: [], rowCount: 0 };
      row.status = status; row.updatedBy = actorId; row.updatedAt = new Date(); return { rows: [{ ...row }], rowCount: 1 };
    }
    if (q.startsWith('UPDATE shipments SET')) {
      const id = values.at(-1), actorId = values.at(-2), row = this.shipments.get(id); if (!row) return { rows: [], rowCount: 0 };
      const map = { carrier: 'carrier', origin_port: 'originPort', destination_port: 'destinationPort', departure_date: 'departureDate', estimated_arrival_date: 'estimatedArrivalDate' };
      const columns = [...q.matchAll(/([a-z_]+)=\$\d+/g)].map((match) => match[1]);
      columns.forEach((column, index) => { const key = map[column]; if (key) row[key] = values[index]; });
      row.updatedBy = actorId; row.updatedAt = new Date(); return { rows: [{ ...row }], rowCount: 1 };
    }
    if (q.startsWith('SELECT s.id,s.tracking_reference AS "trackingReference"') && q.includes('FROM shipments s JOIN users')) {
      const rows = [...this.shipments.values()].map((shipment) => ({ ...shipment, customerName: this.users.get(shipment.customerId).name, customerEmail: this.users.get(shipment.customerId).email }));
      return { rows, rowCount: rows.length };
    }
    if (q.startsWith('SELECT id,tracking_reference AS "trackingReference"') && q.includes('WHERE customer_id=$1 AND tracking_reference=$2')) {
      const row = [...this.shipments.values()].find((item) => item.customerId === values[0] && item.trackingReference === values[1]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (q.startsWith('SELECT id,tracking_reference AS "trackingReference"') && q.includes('WHERE customer_id=$1 ORDER BY')) {
      const rows = [...this.shipments.values()].filter((item) => item.customerId === values[0]); return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (q.startsWith('SELECT id,shipment_id AS "shipmentId"')) {
      const rows = this.milestones.filter((event) => values[0].includes(event.shipmentId)).sort((a, b) => a.occurredAt - b.occurredAt || a.createdAt - b.createdAt).map((event) => ({ ...event }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unexpected test database query: ${q}`);
  }
}

const customerOneId = '00000000-0000-4000-8000-000000000001';
const customerTwoId = '00000000-0000-4000-8000-000000000002';
const adminId = '00000000-0000-4000-8000-000000000003';
const vehicleId = '00000000-0000-4000-8000-000000000011';
const enquiryId = '00000000-0000-4000-8000-000000000021';
const futureDate = (days) => { const date = new Date(); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
async function setup(t) {
  const db = new ShipmentTestDatabase(); const app = buildApp({ db, config: { logLevel: 'silent' } }); await app.ready(); t.after(() => app.close());
  const tokens = {};
  for (const id of [customerOneId, customerTwoId, adminId]) tokens[id] = (await createSession(db, id, 1)).token;
  const headers = (id) => ({ cookie: `portside_session=${tokens[id]}` });
  return { db, app, headers };
}
const shipmentInput = { customerId: customerOneId, vehicleId, enquiryId, carrier: 'Manual carrier entry', originPort: 'Yokohama', destinationPort: 'Mombasa', departureDate: futureDate(7), estimatedArrivalDate: futureDate(30) };

test('customer shipment dashboard is empty and protected when no shipments exist', async (t) => {
  const { app, headers } = await setup(t);
  assert.equal((await app.inject({ method: 'GET', url: '/api/shipments' })).statusCode, 401);
  const empty = await app.inject({ method: 'GET', url: '/api/shipments', headers: headers(customerOneId) });
  assert.equal(empty.statusCode, 200); assert.deepEqual(empty.json().shipments, []);
});

test('admin creates shipment, advances milestones and customer reads only owned records', async (t) => {
  const { app, db, headers } = await setup(t);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/customers', headers: headers(customerOneId) })).statusCode, 403);
  const ownable = await app.inject({ method: 'GET', url: `/api/admin/customers/${customerOneId}/records`, headers: headers(adminId) });
  assert.equal(ownable.statusCode, 200); assert.equal(ownable.json().vehicles[0].id, vehicleId); assert.equal(ownable.json().enquiries[0].id, enquiryId);
  const denied = await app.inject({ method: 'POST', url: '/api/admin/shipments', headers: headers(customerOneId), payload: shipmentInput });
  assert.equal(denied.statusCode, 403);
  const created = await app.inject({ method: 'POST', url: '/api/admin/shipments', headers: headers(adminId), payload: shipmentInput });
  assert.equal(created.statusCode, 201);
  const { shipment } = created.json(); assert.match(shipment.trackingReference, /^PST-SHP-\d{4}-[A-F0-9]{8}$/);
  assert.equal(shipment.status, 'purchase_confirmed'); assert.equal(db.milestones.length, 1);
  const customerCannotAdvance = await app.inject({ method: 'POST', url: `/api/admin/shipments/${shipment.id}/milestones`, headers: headers(customerOneId), payload: { status: 'export_processing' } });
  assert.equal(customerCannotAdvance.statusCode, 403);
  const advanced = await app.inject({ method: 'POST', url: `/api/admin/shipments/${shipment.id}/milestones`, headers: headers(adminId), payload: { status: 'export_processing', note: 'Export paperwork received.' } });
  assert.equal(advanced.statusCode, 200); assert.equal(advanced.json().milestone.source, 'manual'); assert.equal(advanced.json().milestone.actorId, adminId);
  const customerList = await app.inject({ method: 'GET', url: '/api/shipments', headers: headers(customerOneId) });
  assert.equal(customerList.statusCode, 200); assert.equal(customerList.json().shipments.length, 1);
  assert.equal(customerList.json().shipments[0].milestones.length, 2); assert.equal('actorId' in customerList.json().shipments[0].milestones[0], false);
  const otherList = await app.inject({ method: 'GET', url: '/api/shipments', headers: headers(customerTwoId) }); assert.deepEqual(otherList.json().shipments, []);
  const hiddenReference = await app.inject({ method: 'GET', url: `/api/shipments/${shipment.trackingReference}`, headers: headers(customerTwoId) }); assert.equal(hiddenReference.statusCode, 404);
  const byReference = await app.inject({ method: 'GET', url: `/api/shipments/${shipment.trackingReference}`, headers: headers(customerOneId) }); assert.equal(byReference.statusCode, 200);
  assert.ok(db.audits.length >= 2);
});

test('shipment creation and milestone transitions reject invalid references, dates, and statuses', async (t) => {
  const { app, headers } = await setup(t);
  const invalidDate = await app.inject({ method: 'POST', url: '/api/admin/shipments', headers: headers(adminId), payload: { ...shipmentInput, departureDate: '2026-02-30' } });
  assert.equal(invalidDate.statusCode, 400);
  const reversedDates = await app.inject({ method: 'POST', url: '/api/admin/shipments', headers: headers(adminId), payload: { ...shipmentInput, departureDate: futureDate(30), estimatedArrivalDate: futureDate(7) } });
  assert.equal(reversedDates.statusCode, 400);
  const wrongOwnerVehicle = await app.inject({ method: 'POST', url: '/api/admin/shipments', headers: headers(adminId), payload: { ...shipmentInput, customerId: customerTwoId } });
  assert.equal(wrongOwnerVehicle.statusCode, 400);
  const created = await app.inject({ method: 'POST', url: '/api/admin/shipments', headers: headers(adminId), payload: { ...shipmentInput, vehicleId: undefined, enquiryId: undefined } });
  assert.equal(created.statusCode, 201);
  const id = created.json().shipment.id;
  const skip = await app.inject({ method: 'POST', url: `/api/admin/shipments/${id}/milestones`, headers: headers(adminId), payload: { status: 'departed' } });
  assert.equal(skip.statusCode, 400);
  const badStamp = await app.inject({ method: 'POST', url: `/api/admin/shipments/${id}/milestones`, headers: headers(adminId), payload: { status: 'export_processing', occurredAt: 'not-a-date' } });
  assert.equal(badStamp.statusCode, 400);
  const future = await app.inject({ method: 'POST', url: `/api/admin/shipments/${id}/milestones`, headers: headers(adminId), payload: { status: 'export_processing', occurredAt: '2999-01-01T00:00:00Z' } });
  assert.equal(future.statusCode, 400);
  const unknown = await app.inject({ method: 'GET', url: '/api/shipments/PST-SHP-2099-DEADBEEF', headers: headers(customerOneId) });
  assert.equal(unknown.statusCode, 404);
});

test('admin can edit shipment details and milestones must remain chronological', async (t) => {
  const { app, headers } = await setup(t);
  const created = await app.inject({ method: 'POST', url: '/api/admin/shipments', headers: headers(adminId), payload: { ...shipmentInput, vehicleId: undefined, enquiryId: undefined } });
  const shipment = created.json().shipment;
  const edit = await app.inject({ method: 'PATCH', url: `/api/admin/shipments/${shipment.id}`, headers: headers(adminId), payload: { carrier: 'Updated manually', estimatedArrivalDate: futureDate(60) } });
  assert.equal(edit.statusCode, 200); assert.equal(edit.json().shipment.carrier, 'Updated manually');
  const eventTime = new Date().toISOString();
  const before = await app.inject({ method: 'POST', url: `/api/admin/shipments/${shipment.id}/milestones`, headers: headers(adminId), payload: { status: 'export_processing', occurredAt: eventTime } });
  assert.equal(before.statusCode, 200);
  const retroactive = await app.inject({ method: 'POST', url: `/api/admin/shipments/${shipment.id}/milestones`, headers: headers(adminId), payload: { status: 'awaiting_vessel', occurredAt: new Date(Date.parse(eventTime) - 1000).toISOString() } });
  assert.equal(retroactive.statusCode, 400);
  const dashboard = await app.inject({ method: 'GET', url: '/api/shipments', headers: headers(customerOneId) });
  assert.equal(dashboard.json().shipments[0].status, 'export_processing');
  assert.deepEqual(dashboard.json().shipments[0].milestones.map((item) => item.status), ['purchase_confirmed', 'export_processing']);
});
