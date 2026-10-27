const models = [
  { name: 'Toyota Harrier', value: 1850000 }, { name: 'Toyota Prado', value: 3200000 },
  { name: 'Mazda CX-5', value: 1400000 }, { name: 'Nissan X-Trail', value: 1250000 },
  { name: 'Toyota Corolla', value: 1100000 }, { name: 'Honda CR-V', value: 1600000 },
  { name: 'Subaru Forester', value: 1500000 }, { name: 'Other vehicle', value: null }
];
function currentMonth() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit' }); }
function validateVehicle(data) {
  const model = String(data.model || '').trim();
  if (!model || model.length > 80) throw new Error('Enter a vehicle model of up to 80 characters.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(data.registration || '') || data.registration < '1900-01' || data.registration > currentMonth()) throw new Error('Enter a registration month between January 1900 and this month.');
  const engine = Number(data.engine);
  if (!Number.isInteger(engine) || engine < 0 || engine > 10000) throw new Error('Engine capacity must be a whole number between 0 and 10,000 cc.');
  if (!['Petrol', 'Diesel', 'Hybrid', 'Electric'].includes(data.fuel)) throw new Error('Choose a supported fuel type.');
  if (data.fuel !== 'Electric' && engine < 600) throw new Error('Enter at least 600 cc for a combustion engine.');
  if (data.fuel === 'Electric' && engine !== 0) throw new Error('Use 0 cc for an electric vehicle.');
  const value = data.value === '' || data.value == null ? models.find((item) => item.name === model)?.value : Number(data.value);
  if (!Number.isFinite(value) || value < 100000 || value > 100000000) throw new Error('Enter a reference vehicle value between Ksh 100,000 and Ksh 100,000,000.');
  const freight = data.freight === '' || data.freight == null ? 120000 : Number(data.freight);
  const fees = data.fees === '' || data.fees == null ? 80000 : Number(data.fees);
  if (![freight, fees].every((n) => Number.isFinite(n) && n >= 0 && n <= 10000000)) throw new Error('Freight and local fees must be between 0 and Ksh 10,000,000.');
  return { model, registration: data.registration, engine, fuel: data.fuel, value, freight, fees };
}
function estimate(input, offset = 0) {
  const [year, month] = currentMonth().split('-').map(Number), [regYear, regMonth] = input.registration.split('-').map(Number);
  const age = Math.max(0, (year - regYear) * 12 + month - regMonth + offset);
  const depreciation = Math.min(.7, Math.floor(age / 12) * .05);
  const customs = Math.round(input.value * (1 - depreciation) + input.freight);
  const duty = Math.round(customs * .25);
  const engineRate = input.engine > 2500 ? .25 : .2;
  const exciseRate = input.fuel === 'Electric' ? .1 : input.fuel === 'Hybrid' ? .15 : engineRate;
  const excise = Math.round((customs + duty) * exciseRate);
  const vat = Math.round((customs + duty + excise) * .16);
  const idf = Math.round(customs * .02), rdl = Math.round(customs * .015);
  return { offset, depreciation, rows: [['Illustrative customs value (includes freight)', customs], ['Demo import duty', duty], ['Demo excise', excise], ['Demo VAT', vat], ['Demo IDF', idf], ['Demo RDL', rdl], ['Local fees', input.fees]], total: customs + duty + excise + vat + idf + rdl + input.fees };
}
const notice = 'Illustrative estimate only. These sample rates and annual age bands are not verified KRA rules, an eligibility assessment, or a payable quote. Reference values are examples. Confirm costs and eligibility with an authorised clearing agent.';
async function provider(action, input) {
  const url = process.env[`PORTSIDE_${action.toUpperCase()}_URL`];
  if (!url) return null;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.PORTSIDE_PROVIDER_TOKEN ? { Authorization: `Bearer ${process.env.PORTSIDE_PROVIDER_TOKEN}` } : {}) }, body: JSON.stringify(input), signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('The connected data provider is unavailable. Please retry.');
  const data = await response.json();
  if (!data || typeof data.title !== 'string' || !Array.isArray(data.rows) || data.rows.length > 40 || !data.rows.every((row) => Array.isArray(row) && row.length === 2 && row.every((v) => ['string', 'number'].includes(typeof v)))) throw new Error('The data provider returned an invalid response.');
  if (['quote', 'advisor'].includes(action) && (!Number.isFinite(data.total) || data.total < 0)) throw new Error('The provider returned an invalid total.');
  return { title: data.title.slice(0, 200), rows: data.rows, total: data.total, notice: String(data.notice || 'Connected provider result. Verify its source and effective date before making a decision.').slice(0, 2000), source: 'provider', updatedAt: new Date().toISOString(), input };
}
async function runService(action, data) {
  let input;
  if (['quote', 'advisor'].includes(action)) input = validateVehicle(data);
  else {
    const reference = String(data.reference || '').trim().toUpperCase();
    if (action === 'vin' && !/^[A-HJ-NPR-Z0-9]{17}$/.test(reference)) throw new Error('A VIN must contain 17 letters and digits, excluding I, O and Q.');
    if (action === 'tracking' && !/^(?:[A-Z]{4}\d{7}|[A-Z0-9][A-Z0-9-]{5,39})$/.test(reference)) throw new Error('Enter a container number (4 letters and 7 digits) or a BL reference of 6–40 letters, digits or hyphens.');
    input = { reference };
  }
  const live = await provider(action, input);
  if (live) return live;
  const updatedAt = new Date().toISOString();
  if (action === 'quote') return { ...estimate(input), title: `Landed-cost estimate · ${input.model}`, notice, source: 'demo', input, updatedAt };
  if (action === 'advisor') {
    const comparisons = [0, 1, 2].map((offset) => estimate(input, offset));
    return { title: `Timing comparison · ${input.model}`, rows: comparisons.map((item) => [item.offset ? `In ${item.offset} month${item.offset > 1 ? 's' : ''}` : 'Now', item.total]), total: comparisons[0].total, comparisons, notice: `${notice} Holding costs, exchange-rate changes and future policy changes are excluded.`, source: 'demo', input, updatedAt };
  }
  if (action === 'vin') {
    if (input.reference !== 'JTMBE31V006123456') return { title: 'No demo vehicle found', rows: [], notice: 'No live history provider is configured. Try sample VIN JTMBE31V006123456. An absent demo record says nothing about the vehicle’s real history.', source: 'demo', input, updatedAt };
    return { title: 'Sample history · Toyota Harrier', rows: [['VIN', input.reference], ['Odometer', '68,400 km'], ['Accidents', 'None in fictional record'], ['Auction grade', '4.5'], ['First registration', 'December 2019']], notice: 'Fictional record. No live VIN or auction provider is configured.', source: 'demo', input, updatedAt };
  }
  if (!['BL-KE-1024', 'MSKU1234567'].includes(input.reference)) return { title: 'No demo shipment found', rows: [], notice: 'No carrier is connected. Try BL-KE-1024 or MSKU1234567.', source: 'demo', input, updatedAt };
  return { title: 'Sample shipment · In transit', rows: [['Reference', input.reference], ['Route', 'Yokohama → Mombasa'], ['Departed (sample)', '24 Sep 2026'], ['Estimated arrival (sample)', '18 Oct 2026'], ['Last sample event', 'Vessel departed origin port']], milestones: [{ label: 'Booking confirmed', date: '2026-09-20', complete: true }, { label: 'Vessel departed', date: '2026-09-24', complete: true }, { label: 'Arrival at Mombasa', date: '2026-10-18', complete: false }, { label: 'Cleared for collection', date: null, complete: false }], notice: 'Static fictional shipment, last sample event 24 Sep 2026. Its estimated arrival is not a live update.', source: 'demo', input, updatedAt };
}
module.exports = { models, currentMonth, runService };
