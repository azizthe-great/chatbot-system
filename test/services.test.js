const test = require('node:test');
const assert = require('node:assert/strict');
const { runService, currentMonth } = require('../services');
const vehicle = { model: 'Toyota Harrier', registration: '2019-12', engine: 2000, fuel: 'Petrol', value: 1850000, freight: 120000, fees: 80000 };
test('estimates respond to each relevant input and totals reconcile', async () => {
  const base = await runService('quote', vehicle);
  assert.equal(base.source, 'demo'); assert.match(base.notice, /not verified KRA/);
  assert.equal(base.total, base.rows.reduce((sum, row) => sum + row[1], 0));
  for (const override of [{ registration: currentMonth() }, { engine: 3000 }, { fuel: 'Hybrid' }, { fuel: 'Electric', engine: 0 }, { value: 2200000 }, { freight: 150000 }, { fees: 100000 }]) {
    assert.notEqual((await runService('quote', { ...vehicle, ...override })).total, base.total, JSON.stringify(override));
  }
  const timing = await runService('advisor', vehicle); assert.equal(timing.comparisons.length, 3); assert.equal(timing.rows[0][1], base.total);
});
test('service validation rejects invalid dates, engines, values and references', async () => {
  for (const override of [{ registration: '2100-01' }, { registration: '2020-13' }, { engine: -1 }, { engine: 2000.5 }, { value: 'no' }, { fuel: 'Electric' }, { fuel: 'Gas' }, { fees: -1 }]) await assert.rejects(runService('quote', { ...vehicle, ...override }));
  await assert.rejects(runService('vin', { reference: 'INVALID' }));
  await assert.rejects(runService('vin', { reference: 'ITMBE31V006123456' }));
  await assert.rejects(runService('tracking', { reference: '<bad>' }));
  assert.match((await runService('vin', { reference: 'JTMBE31V006123456' })).title, /Sample history/);
  assert.match((await runService('vin', { reference: 'JTMBE31V006123457' })).title, /No demo/);
  assert.equal((await runService('tracking', { reference: 'MSKU1234567' })).milestones.length, 4);
});
test('configured providers are validated and failures never silently fall back to demo data', async () => {
  const originalFetch = global.fetch; process.env.PORTSIDE_QUOTE_URL = 'https://provider.example/quote';
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ title: 'Provider estimate', rows: [['Total', 150000]], total: 150000, notice: 'Provider effective date' }) });
    assert.equal((await runService('quote', vehicle)).source, 'provider');
    global.fetch = async () => ({ ok: false }); await assert.rejects(runService('quote', vehicle), /unavailable/);
    global.fetch = async () => ({ ok: true, json: async () => ({ title: 'Bad', rows: [], total: 'wrong' }) }); await assert.rejects(runService('quote', vehicle), /invalid total/);
  } finally { global.fetch = originalFetch; delete process.env.PORTSIDE_QUOTE_URL; }
});
