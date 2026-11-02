'use strict';

const sourceReferences = [
  { label: 'KRA used motor vehicle CRSP notice', url: 'https://www.zd.kra.go.ke/news-center/public-notices/2223-current-retail-selling-price-crsp-for-used-motor-vehicles' },
  { label: 'KRA CRSP implementation clarification', url: 'https://www.kra.go.ke/news-center/press-release/2224-clarification-on-implementation-of-revised-current-retail-selling-price-crsp-list-for-used-motor-vehicles' },
  { label: 'KRA vehicle valuation clarification (2026)', url: 'https://www.kra.go.ke/news-center/press-release/2392-clarification-on-concerns-regarding-cargo-clearance-raised-by-clearing-agents-and-motor-vehicle-dealers' },
  { label: 'KRA foreign exchange rates', url: 'https://www.kra.go.ke/foreign-exchange' },
  { label: 'CBK indicative foreign exchange rates', url: 'https://www.centralbank.go.ke/rates/forex-exchange-rates/' },
  { label: 'KRA vehicle import guide (published 27 January 2021; historical rates only)', url: 'https://www.kra.go.ke/news-center/blog/1075-what-you-need-to-know-when-importing-a-motor-vehicle' }
];

const taxRules = [
  { key: 'importDuty', label: 'Import duty', status: 'configured', rate: 0.25, basis: ['customsValueKsh'], source: sourceReferences[5].url, sourceDate: '2021-01-27' },
  { key: 'exciseDuty', label: 'Excise duty', status: 'configured', rate: null, engineCapacityRates: [{ max: 1500, rate: 0.20 }, { min: 1501, rate: 0.25 }], fuelTypes: ['petrol', 'diesel', 'hybrid'], basis: ['customsValueKsh', 'importDuty'], source: sourceReferences[5].url, sourceDate: '2021-01-27' },
  { key: 'vat', label: 'VAT', status: 'configured', rate: 0.16, basis: ['customsValueKsh', 'importDuty', 'exciseDuty'], source: sourceReferences[5].url, sourceDate: '2021-01-27' },
  { key: 'idf', label: 'Import declaration fee (IDF)', status: 'configured', rate: 0.035, basis: ['customsValueKsh'], source: sourceReferences[5].url, sourceDate: '2021-01-27' },
  { key: 'rdl', label: 'Railway development levy (RDL)', status: 'configured', rate: 0.02, basis: ['customsValueKsh'], source: sourceReferences[5].url, sourceDate: '2021-01-27' }
];

const chargeRules = [
  { key: 'portCharges', label: 'Port and terminal charges', status: 'unconfigured', amountKsh: null, source: null, effectiveDate: null },
  { key: 'shippingAgent', label: 'Shipping-agent charges', status: 'unconfigured', amountKsh: null, source: null, effectiveDate: null },
  { key: 'clearingCharges', label: 'Clearing charges', status: 'unconfigured', amountKsh: null, source: null, effectiveDate: null },
  { key: 'registrationInspection', label: 'Registration and inspection', status: 'unconfigured', amountKsh: null, source: null, effectiveDate: null },
  { key: 'otherCharges', label: 'Other charges', status: 'unconfigured', amountKsh: null, source: null, effectiveDate: null }
];

module.exports = {
  reviewedOn: '2026-11-02',
  rulesetStatus: 'historical_reference',
  valuationRule: { status: 'unconfigured', source: sourceReferences[0].url },
  taxRules,
  chargeRules,
  sourceReferences,
  assumptions: [
    'This calculation uses a KRA vehicle-import blog dated 27 January 2021 as a historical reference. It is not a live KRA connection and these rates are not represented as current.',
    'The KRA page states IDF as 3.5% in its text but uses 4% in its worked example; this illustration follows the text rate and flags the discrepancy.',
    'The vehicle valuation question is subject to ongoing court proceedings according to KRA. Use a KRA- or clearing-agent-assessed customs value; historical rules never produce a final total.'
  ]
};
