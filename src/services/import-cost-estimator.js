'use strict';

const DEFAULT_RULES = require('../config/import-cost-rules');

const SUPPORTED_CURRENCIES = Object.freeze(['KES', 'USD', 'GBP', 'EUR', 'JPY', 'AED', 'ZAR', 'CAD', 'AUD', 'SGD', 'INR', 'CNY', 'HKD']);
const SUPPORTED_FUEL_TYPES = Object.freeze(['petrol', 'diesel', 'hybrid', 'electric', 'other']);
const MAX_AMOUNT = 1_000_000_000_000;

class ImportEstimateError extends Error {
  constructor(message) { super(message); this.name = 'ImportEstimateError'; this.statusCode = 400; }
}

function amount(value, label, { required = false, allowZero = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ImportEstimateError(`${label} is required.`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value > MAX_AMOUNT || value < 0 || (!allowZero && value === 0)) {
    throw new ImportEstimateError(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} number in range.`);
  }
  return value;
}

function roundMoney(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ImportEstimateError('Provide vehicle and purchase details.');
  const make = typeof input.make === 'string' ? input.make.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!make || make.length > 80) throw new ImportEstimateError('Make is required and must be no more than 80 characters.');
  if (!model || model.length > 100) throw new ImportEstimateError('Model is required and must be no more than 100 characters.');
  if (!Number.isInteger(input.year) || input.year < 1886 || input.year > new Date().getUTCFullYear()) throw new ImportEstimateError('Year of manufacture must be a valid year no later than the current year.');
  const fuelType = typeof input.fuelType === 'string' ? input.fuelType.trim().toLowerCase() : '';
  if (!SUPPORTED_FUEL_TYPES.includes(fuelType)) throw new ImportEstimateError(`Fuel type must be one of: ${SUPPORTED_FUEL_TYPES.join(', ')}.`);
  const engineCapacityCc = amount(input.engineCapacityCc, 'Engine capacity', { allowZero: false });
  if (engineCapacityCc !== null && (!Number.isInteger(engineCapacityCc) || engineCapacityCc > 20000)) throw new ImportEstimateError('Engine capacity must be a whole number from 1 to 20000 cc.');
  const purchasePrice = amount(input.purchasePrice, 'Purchase price', { required: true });
  const freightCost = amount(input.freightCost, 'Freight cost', { allowZero: true });
  const insuranceCost = amount(input.insuranceCost, 'Insurance cost', { allowZero: true });
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
  if (!SUPPORTED_CURRENCIES.includes(currency)) throw new ImportEstimateError(`Currency is unsupported. Choose one of: ${SUPPORTED_CURRENCIES.join(', ')}.`);
  const countryOfExport = typeof input.countryOfExport === 'string' ? input.countryOfExport.trim() : '';
  if (!countryOfExport || countryOfExport.length > 80) throw new ImportEstimateError('Country of purchase or export is required and must be no more than 80 characters.');
  const customsValueKsh = amount(input.customsValueKsh, 'KRA-assessed customs value', { allowZero: false });
  if (customsValueKsh !== null && customsValueKsh <= 0) throw new ImportEstimateError('KRA-assessed customs value must be positive.');

  const exchangeRate = amount(input.exchangeRate, 'Exchange rate', { allowZero: false });
  const exchangeRateDate = input.exchangeRateDate === undefined || input.exchangeRateDate === '' ? null : input.exchangeRateDate;
  const exchangeRateSource = typeof input.exchangeRateSource === 'string' ? input.exchangeRateSource.trim() : '';
  if (currency === 'KES' && (exchangeRate !== null || exchangeRateDate || exchangeRateSource)) throw new ImportEstimateError('Do not provide an exchange rate for KES inputs.');
  if (currency !== 'KES' && exchangeRate !== null) {
    const validDate = typeof exchangeRateDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(exchangeRateDate) && !Number.isNaN(Date.parse(`${exchangeRateDate}T00:00:00Z`)) && new Date(`${exchangeRateDate}T00:00:00Z`).toISOString().slice(0, 10) === exchangeRateDate;
    if (!validDate || !exchangeRateSource || exchangeRateSource.length > 200) throw new ImportEstimateError('An entered exchange rate requires a valid date and a source (up to 200 characters).');
  } else if (currency !== 'KES' && (exchangeRateDate || exchangeRateSource)) {
    throw new ImportEstimateError('Provide the exchange rate together with its date and source, or leave all three blank.');
  }
  return { make, model, year: input.year, engineCapacityCc, fuelType, purchasePrice, freightCost, insuranceCost, currency, countryOfExport, customsValueKsh, exchangeRate, exchangeRateDate, exchangeRateSource: exchangeRateSource || null };
}

function configuredTaxAmount(rule, bases, vehicle) {
  if (rule.status === 'not_applicable') return { amountKsh: 0, status: 'not_applicable' };
  let rate = rule.rate;
  if (Array.isArray(rule.engineCapacityRates)) {
    if (rule.fuelTypes && !rule.fuelTypes.includes(vehicle.fuelType)) {
      return { amountKsh: null, status: 'unconfigured', reason: 'This historical engine-capacity rule does not cover the selected fuel type.' };
    }
    const tier = rule.engineCapacityRates.find((item) =>
      Number.isInteger(vehicle.engineCapacityCc)
      && (item.min === undefined || vehicle.engineCapacityCc >= item.min)
      && (item.max === undefined || vehicle.engineCapacityCc <= item.max)
    );
    if (!tier) return { amountKsh: null, status: 'unconfigured', reason: 'Engine capacity is required for this historical rate.' };
    rate = tier.rate;
  }
  if (rule.status !== 'configured' || !Number.isFinite(rate) || rate < 0 || rate > 5 || !Array.isArray(rule.basis) || !rule.basis.length) {
    return { amountKsh: null, status: 'unconfigured', reason: 'Rate, taxable base, or applicability is not configured.' };
  }
  if (!rule.source || !(rule.effectiveDate || rule.sourceDate)) return { amountKsh: null, status: 'unconfigured', reason: 'A source and effective/source date are required for configured tax rules.' };
  const selectedBases = rule.basis.map((key) => bases[key]);
  if (selectedBases.some((value) => !Number.isFinite(value))) return { amountKsh: null, status: 'unconfigured', reason: 'Required taxable valuation or preceding tax amount is unavailable.' };
  return { amountKsh: roundMoney(selectedBases.reduce((sum, value) => sum + value, 0) * rate), status: 'configured', rate };
}

function calculateImportEstimate(input, rules = DEFAULT_RULES) {
  const data = validateInput(input);
  const rate = data.currency === 'KES' ? 1 : data.exchangeRate;
  const convert = (value) => value === null || rate === null ? null : roundMoney(value * rate);
  const costLines = [
    { key: 'purchasePrice', label: 'Vehicle purchase price', enteredAmount: data.purchasePrice, status: 'provided' },
    { key: 'freight', label: 'Freight', enteredAmount: data.freightCost, status: data.freightCost === null ? 'not_provided' : 'provided' },
    { key: 'insurance', label: 'Insurance', enteredAmount: data.insuranceCost, status: data.insuranceCost === null ? 'not_provided' : 'provided' }
  ].map((line) => ({ ...line, currency: data.currency, amountKsh: convert(line.enteredAmount) }));

  const knownCostValues = costLines.map((line) => line.amountKsh).filter(Number.isFinite);
  const knownCostsSubtotalKsh = knownCostValues.length ? roundMoney(knownCostValues.reduce((sum, value) => sum + value, 0)) : null;
  const valuation = data.customsValueKsh === null
    ? { amountKsh: null, status: 'unconfigured', source: rules.valuationRule?.source || null }
    : { amountKsh: data.customsValueKsh, status: 'user_supplied', source: 'User-entered KRA/clearing-agent value' };
  const bases = { customsValueKsh: valuation.amountKsh };
  const taxLines = (rules.taxRules || []).map((rule) => {
    const calculated = configuredTaxAmount(rule, bases, data);
    if (calculated.amountKsh !== null && rule.key) bases[rule.key] = calculated.amountKsh;
    return { key: rule.key, label: rule.label, category: 'tax', ...calculated, rate: calculated.status === 'configured' ? calculated.rate : null, source: rule.source || null, effectiveDate: rule.effectiveDate || null, sourceDate: rule.sourceDate || null };
  });
  const chargeLines = (rules.chargeRules || []).map((rule) => {
    const configured = rule.status === 'configured' && Number.isFinite(rule.amountKsh) && rule.amountKsh >= 0 && rule.source && rule.effectiveDate;
    const notApplicable = rule.status === 'not_applicable';
    return {
      key: rule.key, label: rule.label, category: 'charge',
      amountKsh: notApplicable ? 0 : configured ? roundMoney(rule.amountKsh) : null,
      status: notApplicable ? 'not_applicable' : configured ? 'configured' : 'unconfigured',
      source: rule.source || null, effectiveDate: rule.effectiveDate || null
    };
  });
  const missingInformation = [];
  if (data.currency !== 'KES' && data.exchangeRate === null) missingInformation.push('Enter the KSh-per-unit exchange rate, its date, and source to convert foreign currency.');
  if (data.freightCost === null) missingInformation.push('Freight cost was not provided.');
  if (data.insuranceCost === null) missingInformation.push('Insurance cost was not provided.');
  if (valuation.status === 'unconfigured') missingInformation.push('Official customs valuation is unavailable; purchase price alone is not treated as customs value.');
  for (const line of [...taxLines, ...chargeLines]) if (line.status === 'unconfigured') missingInformation.push(`${line.label} is unconfigured for this estimate.`);
  if (rules.rulesetStatus === 'historical_reference') missingInformation.push('Historical reference rules cannot produce a current final total; confirm current rates and charges with KRA or a licensed clearing agent.');
  const totalReady = costLines.every((line) => line.status === 'provided' && Number.isFinite(line.amountKsh))
    && valuation.amountKsh !== null
    && rules.rulesetStatus !== 'historical_reference'
    && [...taxLines, ...chargeLines].every((line) => line.status === 'configured' || line.status === 'not_applicable');
  const totalKsh = totalReady
    ? roundMoney([...costLines, ...taxLines, ...chargeLines].reduce((sum, line) => sum + line.amountKsh, 0))
    : null;

  return {
    status: totalReady ? 'complete_estimate' : 'partial_estimate',
    vehicle: { make: data.make, model: data.model, year: data.year, engineCapacityCc: data.engineCapacityCc, fuelType: data.fuelType, countryOfExport: data.countryOfExport },
    currencyConversion: data.currency === 'KES'
      ? { status: 'not_required', currency: 'KES', rate: 1, date: null, source: 'Entered in KSh' }
      : data.exchangeRate === null
        ? { status: 'unavailable', currency: data.currency, rate: null, date: null, source: null }
        : { status: 'user_supplied', currency: data.currency, rate: data.exchangeRate, date: data.exchangeRateDate, source: data.exchangeRateSource, definition: 'KES per 1 unit of entered currency' },
    valuation,
    lines: [
      ...costLines.map((line) => ({ ...line, category: 'entered_cost' })),
      { key: 'customsValue', label: 'Customs valuation (not a cost)', category: 'valuation', amountKsh: valuation.amountKsh, status: valuation.status, source: valuation.source },
      ...taxLines,
      ...chargeLines
    ],
    knownCostsSubtotalKsh,
    totalKsh,
    missingInformation,
    assumptions: [
      'Entered purchase, freight, and insurance figures are user-provided transaction amounts; they do not determine official Kenyan customs value.',
      'No tariff, tax base, exemption, or fee applicability is assumed when the rule is not configured.',
      'Any foreign-exchange conversion uses the rate, date, and source entered by the user; it is not represented as a KRA customs rate.',
      'This estimate is not an official customs assessment or clearing quote.',
      ...(rules.assumptions || [])
    ],
    rulesetStatus: rules.rulesetStatus || 'configured',
    rulesReviewedOn: rules.reviewedOn || null,
    sourceReferences: rules.sourceReferences || []
  };
}

module.exports = { calculateImportEstimate, ImportEstimateError, SUPPORTED_CURRENCIES, SUPPORTED_FUEL_TYPES };
