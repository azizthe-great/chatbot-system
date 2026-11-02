'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateImportEstimate, ImportEstimateError } = require('../src/services/import-cost-estimator');
const { createSession } = require('../src/services/auth');
const { buildApp } = require('../server');

const baseInput = {
  make: 'Toyota', model: 'Harrier', year: 2020, engineCapacityCc: 2000, fuelType: 'petrol',
  purchasePrice: 1000, currency: 'KES', countryOfExport: 'Japan', freightCost: 100, insuranceCost: 20,
  customsValueKsh: 1120
};
const sourceDate = '2026-10-25';
function configuredRules() {
  const configured = (key, label, rate, basis) => ({ key, label, status: 'configured', rate, basis, source: 'Test-only rule fixture', effectiveDate: sourceDate });
  const charge = (key, label, amountKsh) => ({ key, label, status: 'configured', amountKsh, source: 'Test-only fee fixture', effectiveDate: sourceDate });
  return {
    reviewedOn: sourceDate,
    valuationRule: { status: 'configured', source: 'Test-only valuation fixture' },
    taxRules: [
      configured('importDuty', 'Import duty', 0.1, ['customsValueKsh']),
      configured('exciseDuty', 'Excise duty', 0.2, ['customsValueKsh', 'importDuty']),
      configured('vat', 'VAT', 0.16, ['customsValueKsh', 'importDuty', 'exciseDuty']),
      configured('idf', 'IDF', 0.03, ['customsValueKsh']),
      configured('rdl', 'RDL', 0.02, ['customsValueKsh'])
    ],
    chargeRules: [
      charge('portCharges', 'Port charges', 30), charge('shippingAgent', 'Shipping agent', 20),
      charge('clearingCharges', 'Clearing', 40), charge('registrationInspection', 'Registration and inspection', 10),
      charge('otherCharges', 'Other charges', 0)
    ],
    sourceReferences: []
  };
}

test('configured test rules calculate itemized duty bases and a complete total', () => {
  const result = calculateImportEstimate(baseInput, configuredRules());
  const byKey = Object.fromEntries(result.lines.map((line) => [line.key, line]));
  assert.equal(byKey.purchasePrice.amountKsh, 1000);
  assert.equal(byKey.freight.amountKsh, 100);
  assert.equal(byKey.insurance.amountKsh, 20);
  assert.equal(byKey.importDuty.amountKsh, 112);
  assert.equal(byKey.exciseDuty.amountKsh, 246.4);
  assert.equal(byKey.vat.amountKsh, 236.54);
  assert.equal(byKey.idf.amountKsh, 33.6);
  assert.equal(byKey.rdl.amountKsh, 22.4);
  assert.equal(result.knownCostsSubtotalKsh, 1120);
  assert.equal(result.status, 'complete_estimate');
  assert.equal(result.totalKsh, 1870.94);
  assert.match(result.assumptions.at(-1), /not an official customs assessment/i);
});

test('default historical KRA reference computes listed taxes but withholds a final total', () => {
  const result = calculateImportEstimate(baseInput);
  assert.equal(result.status, 'partial_estimate');
  assert.equal(result.totalKsh, null);
  assert.equal(result.rulesetStatus, 'historical_reference');
  assert.equal(result.valuation.status, 'user_supplied');
  const expectedAmounts = { importDuty: 280, exciseDuty: 350, vat: 280, idf: 39.2, rdl: 22.4 };
  for (const [key, amountKsh] of Object.entries(expectedAmounts)) {
    const line = result.lines.find((item) => item.key === key);
    assert.equal(line.status, 'configured');
    assert.equal(line.amountKsh, amountKsh);
    assert.equal(line.sourceDate, '2021-01-27');
  }
  for (const key of ['portCharges', 'shippingAgent', 'clearingCharges', 'registrationInspection', 'otherCharges']) {
    assert.equal(result.lines.find((line) => line.key === key).status, 'unconfigured');
    assert.equal(result.lines.find((line) => line.key === key).amountKsh, null);
  }
  assert.match(result.assumptions.join(' '), /IDF.*3\.5%.*4%/);
  assert.match(result.assumptions.join(' '), /not a live KRA connection/i);
});

test('historical excise reference requires a supported fuel and engine capacity', () => {
  const smallEngine = calculateImportEstimate({ ...baseInput, engineCapacityCc: 1500 });
  assert.equal(smallEngine.lines.find((line) => line.key === 'exciseDuty').rate, 0.2);
  assert.equal(smallEngine.lines.find((line) => line.key === 'exciseDuty').amountKsh, 280);
  const missingCapacity = calculateImportEstimate({ ...baseInput, engineCapacityCc: undefined });
  assert.equal(missingCapacity.lines.find((line) => line.key === 'exciseDuty').status, 'unconfigured');
  assert.equal(missingCapacity.totalKsh, null);
  const electric = calculateImportEstimate({ ...baseInput, fuelType: 'electric' });
  assert.equal(electric.lines.find((line) => line.key === 'exciseDuty').status, 'unconfigured');
  assert.equal(electric.totalKsh, null);
});

test('foreign currency converts only with a supplied rate, date, and source', () => {
  const { customsValueKsh, ...usdInput } = baseInput;
  const missingRate = calculateImportEstimate({ ...usdInput, currency: 'USD' });
  assert.equal(missingRate.currencyConversion.status, 'unavailable');
  assert.equal(missingRate.lines.find((line) => line.key === 'purchasePrice').amountKsh, null);
  assert.equal(missingRate.knownCostsSubtotalKsh, null);
  assert.equal(missingRate.totalKsh, null);

  const converted = calculateImportEstimate({ ...usdInput, currency: 'USD', exchangeRate: 130.25, exchangeRateDate: sourceDate, exchangeRateSource: 'KRA weekly rate sheet' });
  assert.deepEqual(converted.currencyConversion, { status: 'user_supplied', currency: 'USD', rate: 130.25, date: sourceDate, source: 'KRA weekly rate sheet', definition: 'KES per 1 unit of entered currency' });
  assert.equal(converted.lines.find((line) => line.key === 'purchasePrice').amountKsh, 130250);
  assert.equal(converted.totalKsh, null);
});

test('unsupported, missing, negative, and out-of-range inputs are rejected', () => {
  for (const input of [
    { ...baseInput, purchasePrice: -1 },
    { ...baseInput, currency: 'XYZ' },
    { ...baseInput, year: new Date().getUTCFullYear() + 1 },
    { ...baseInput, fuelType: 'hydrogen' },
    { ...baseInput, engineCapacityCc: 20001 },
    { ...baseInput, countryOfExport: '  ' },
    { ...baseInput, currency: 'USD', exchangeRate: 130 },
    { ...baseInput, currency: 'USD', exchangeRate: 130, exchangeRateDate: '2026-02-30', exchangeRateSource: 'manual' }
  ]) assert.throws(() => calculateImportEstimate(input), ImportEstimateError);
});

test('incomplete configured rules remain unconfigured rather than producing unsupported amounts', () => {
  const rules = configuredRules();
  rules.taxRules[0] = { key: 'importDuty', label: 'Import duty', status: 'configured', rate: 0.25, basis: ['customsValueKsh'], source: null, effectiveDate: null };
  const result = calculateImportEstimate(baseInput, rules);
  assert.equal(result.lines.find((line) => line.key === 'importDuty').status, 'unconfigured');
  assert.equal(result.lines.find((line) => line.key === 'importDuty').amountKsh, null);
  assert.equal(result.totalKsh, null);
});

function routeDb(role) {
  const user = { id: `${role}-id`, name: role, email: `${role}@example.test`, role, status: 'active' };
  const sessions = new Map();
  return {
    user,
    async query(sql, values = []) {
      const query = sql.replace(/\s+/g, ' ').trim();
      if (query === 'DELETE FROM sessions WHERE expires_at <= now()') return { rows: [], rowCount: 0 };
      if (query.startsWith('INSERT INTO sessions')) { sessions.set(values[0], { expires_at: new Date(values[2]) }); return { rows: [], rowCount: 1 }; }
      if (query.startsWith('SELECT u.id,u.name,u.email,u.role,u.status,s.expires_at')) return sessions.has(values[0]) ? { rows: [{ ...user, expires_at: sessions.get(values[0]).expires_at }], rowCount: 1 } : { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${query}`);
    }
  };
}

test('estimate endpoint requires a customer session and validates requests', async (t) => {
  const customerDb = routeDb('customer');
  const customerApp = buildApp({ db: customerDb, config: { logLevel: 'silent' } }); await customerApp.ready(); t.after(() => customerApp.close());
  const anonymous = await customerApp.inject({ method: 'POST', url: '/api/import-cost-estimate', payload: baseInput });
  assert.equal(anonymous.statusCode, 401);
  const customerSession = await createSession(customerDb, customerDb.user.id, 1);
  const headers = { cookie: `portside_session=${customerSession.token}` };
  const invalid = await customerApp.inject({ method: 'POST', url: '/api/import-cost-estimate', headers, payload: { ...baseInput, currency: 'XYZ' } });
  assert.equal(invalid.statusCode, 400);
  const valid = await customerApp.inject({ method: 'POST', url: '/api/import-cost-estimate', headers, payload: baseInput });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.json().status, 'partial_estimate');
  assert.equal(valid.json().totalKsh, null);

  const adminDb = routeDb('admin');
  const adminApp = buildApp({ db: adminDb, config: { logLevel: 'silent' } }); await adminApp.ready(); t.after(() => adminApp.close());
  const adminSession = await createSession(adminDb, adminDb.user.id, 1);
  const forbidden = await adminApp.inject({ method: 'POST', url: '/api/import-cost-estimate', headers: { cookie: `portside_session=${adminSession.token}` }, payload: baseInput });
  assert.equal(forbidden.statusCode, 403);
});
