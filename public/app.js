'use strict';
const $ = (selector) => document.querySelector(selector);
const messages = $('#messages');
let currentUser = null;
let state = { queries: [], unresolved: [], knowledge: [], models: {} };
let pendingActivity = Promise.resolve();
async function api(path, data, method = 'POST') {
  const response = await fetch(path, data === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/api/auth/login') showLogin(); throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || 'Request failed.'); }
  return result;
}
function showLogin() {
  currentUser = null;
  for (const id of ['importer-view', 'admin-view', 'app-nav', 'account-menu']) $(`#${id}`).hidden = true;
  $('#login-view').hidden = false;
  $('#admin-nav').hidden = true;
  messages.replaceChildren();
  state = { queries: [], unresolved: [], knowledge: [], models: {} };
  $('#unresolved-queue').replaceChildren(); $('#knowledge-list').replaceChildren();
  $('#customer-vehicles').replaceChildren(); $('#customer-enquiries').replaceChildren(); $('#customer-shipments').replaceChildren();
}
function showApp(user) {
  currentUser = user; $('#login-view').hidden = true; $('#app-nav').hidden = false; $('#account-menu').hidden = false;
  $('#account-name').textContent = `${user.email} · ${user.role}`;
  $('#admin-nav').hidden = user.role !== 'admin';
  $('.records-card').hidden = user.role !== 'customer';
  $('#importer-view').hidden = false; $('#admin-view').hidden = true;
  for (const nav of document.querySelectorAll('[data-view]')) nav.classList.toggle('active', nav.dataset.view === 'importer');
  messages.replaceChildren(); greet();
  if (user.role === 'customer') loadCustomerRecords();
}
function activity(data) {
  pendingActivity = pendingActivity.then(() => api('/api/activity', data)).catch((error) => { if (currentUser) bubble(`Could not save activity: ${error.message}`); });
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; $('#login-error').hidden = true;
  try { const result = await api('/api/auth/login', Object.fromEntries(new FormData(event.target))); event.target.reset(); showApp(result.user); }
  catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; }
  finally { button.disabled = false; }
});
$('#show-register').addEventListener('click', () => {
  $('#login-form').hidden = true; $('#show-register').parentElement.hidden = true;
  $('#register-form').hidden = false; $('#register-name').focus();
});
$('#show-login').addEventListener('click', () => {
  $('#register-form').hidden = true; $('#login-form').hidden = false; $('#show-register').parentElement.hidden = false;
  $('#email').focus();
});
$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button[type="submit"]'); button.disabled = true; $('#register-error').hidden = true;
  try { const result = await api('/api/auth/register', Object.fromEntries(new FormData(event.target))); event.target.reset(); showApp(result.user); }
  catch (error) { $('#register-error').textContent = error.message; $('#register-error').hidden = false; }
  finally { button.disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  try { await pendingActivity; await api('/api/auth/logout', {}); showLogin(); }
  catch (error) { bubble(`Could not sign out: ${error.message}`); }
});
const money = (value) => `Ksh ${Number(value).toLocaleString('en-KE')}`;
const normalize = (value) => value.toLowerCase().replace(/[?!.,]/g, '').replace(/\s+/g, ' ').trim();
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
async function loadCustomerRecords() {
  const status = $('#records-status'); status.textContent = 'Loading your saved records…';
  try {
    const [vehicleData, enquiryData, shipmentData] = await Promise.all([api('/api/vehicles'), api('/api/enquiries'), api('/api/shipments')]);
    if (currentUser?.role !== 'customer') return;
    const vehicleList = $('#customer-vehicles'); vehicleList.replaceChildren();
    const vehicleSelect = $('#enquiry-form').elements.vehicleId;
    vehicleSelect.replaceChildren(new Option('No vehicle selected', ''));
    if (!vehicleData.vehicles.length) vehicleList.append(element('p', 'empty', 'No vehicles saved yet.'));
    for (const vehicle of vehicleData.vehicles) {
      const item = element('div', 'record-item');
      item.append(element('strong', '', `${vehicle.year ? `${vehicle.year} ` : ''}${vehicle.make} ${vehicle.model}`));
      const details = [vehicle.engineCapacityCc ? `${vehicle.engineCapacityCc} cc` : '', vehicle.fuelType || '', vehicle.originCountry || '', vehicle.vin || ''].filter(Boolean).join(' · ');
      if (details) item.append(element('div', '', details));
      vehicleList.append(item); vehicleSelect.add(new Option(`${vehicle.year ? `${vehicle.year} ` : ''}${vehicle.make} ${vehicle.model}`, vehicle.id));
    }
    const enquiryList = $('#customer-enquiries'); enquiryList.replaceChildren();
    if (!enquiryData.enquiries.length) enquiryList.append(element('p', 'empty', 'No enquiries yet.'));
    for (const enquiry of enquiryData.enquiries) {
      const item = element('div', 'record-item');
      item.append(element('strong', '', `${enquiry.reference} · ${enquiry.category}`), element('div', '', `${enquiry.status.replaceAll('_', ' ')} · ${new Date(enquiry.created_at).toLocaleDateString('en-KE')}`), element('p', '', enquiry.description));
      enquiryList.append(item);
    }
    const shipmentList = $('#customer-shipments'); shipmentList.replaceChildren();
    if (!shipmentData.shipments.length) shipmentList.append(element('p', 'empty', 'No shipments are linked to your account yet.'));
    for (const shipment of shipmentData.shipments) shipmentList.append(renderShipmentCard(shipment, false));
    status.textContent = `${vehicleData.vehicles.length} saved vehicle${vehicleData.vehicles.length === 1 ? '' : 's'} · ${enquiryData.enquiries.length} ${enquiryData.enquiries.length === 1 ? 'enquiry' : 'enquiries'} · ${shipmentData.shipments.length} shipment${shipmentData.shipments.length === 1 ? '' : 's'}`;
  } catch (error) { status.textContent = error.message; }
}
const shipmentStatusLabels = {
  purchase_confirmed: 'Purchase confirmed', export_processing: 'Export processing', awaiting_vessel: 'Awaiting vessel',
  departed: 'Departed', in_transit: 'In transit', arrived_destination: 'Arrived at destination',
  customs_clearance: 'Customs clearance', released_delivered: 'Released / delivered'
};
function renderShipmentCard(shipment, isAdmin) {
  const item = element('article', 'shipment-item');
  item.append(element('strong', '', `${shipment.trackingReference} · ${shipmentStatusLabels[shipment.status] || shipment.status}`));
  if (isAdmin) item.append(element('div', '', `${shipment.customerName || shipment.customerEmail || shipment.customerId}`));
  const details = [shipment.carrier ? `Carrier: ${shipment.carrier} (entered manually)` : 'Carrier: not provided', `${shipment.originPort} → ${shipment.destinationPort}`, shipment.departureDate ? `Departure: ${String(shipment.departureDate).slice(0, 10)}` : 'Departure: unknown', shipment.estimatedArrivalDate ? `Estimated arrival: ${String(shipment.estimatedArrivalDate).slice(0, 10)} (estimate)` : 'Estimated arrival: unavailable'];
  item.append(element('p', 'muted', details.join(' · ')));
  const history = element('ol', 'shipment-history');
  for (const milestone of shipment.milestones || []) {
    const row = element('li');
    const when = new Date(milestone.occurredAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
    row.append(element('strong', '', shipmentStatusLabels[milestone.status] || milestone.status), element('span', '', ` · ${when} · Manually entered`));
    if (milestone.note) row.append(element('p', '', milestone.note));
    if (isAdmin && milestone.actorId) row.append(element('small', '', `Updated by account ${milestone.actorId}`));
    history.append(row);
  }
  item.append(history);
  return item;
}
$('#vehicle-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const status = $('#records-status'); button.disabled = true;
  const data = Object.fromEntries(new FormData(form));
  for (const key of ['year', 'engineCapacityCc']) data[key] = data[key] ? Number(data[key]) : undefined;
  for (const key of Object.keys(data)) if (data[key] === undefined || data[key] === '') delete data[key];
  try { await api('/api/vehicles', data); form.reset(); await loadCustomerRecords(); status.textContent = 'Vehicle saved.'; }
  catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
$('#enquiry-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const status = $('#records-status'); button.disabled = true;
  const data = Object.fromEntries(new FormData(form)); if (!data.vehicleId) delete data.vehicleId;
  try { const result = await api('/api/enquiries', data); form.reset(); await loadCustomerRecords(); status.textContent = `Enquiry submitted: ${result.enquiry.reference}`; }
  catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
async function renderAdminEnquiries() {
  const status = $('#admin-enquiry-status'); status.textContent = 'Loading enquiries…';
  try {
    const data = await api('/api/admin/enquiries'); if (currentUser?.role !== 'admin') return;
    const list = $('#admin-enquiries-list'); list.replaceChildren();
    if (!data.enquiries.length) list.append(element('p', 'empty', 'No customer enquiries yet.'));
    for (const enquiry of data.enquiries) {
      const row = element('div', 'admin-enquiry'); const summary = element('div');
      summary.append(element('strong', '', `${enquiry.reference} · ${enquiry.category}`), element('small', '', `${enquiry.customerName} (${enquiry.customerEmail})`), element('p', '', enquiry.description));
      const statusSelect = document.createElement('select'); statusSelect.setAttribute('aria-label', `Status for ${enquiry.reference}`);
      for (const value of ['new', 'in_review', 'waiting_on_customer', 'resolved', 'closed']) statusSelect.add(new Option(value.replaceAll('_', ' '), value, false, value === enquiry.status));
      const prioritySelect = document.createElement('select'); prioritySelect.setAttribute('aria-label', `Priority for ${enquiry.reference}`);
      for (const value of ['low', 'normal', 'high', 'urgent']) prioritySelect.add(new Option(value, value, false, value === enquiry.priority));
      const save = element('button', 'primary', 'Save'); save.type = 'button';
      save.addEventListener('click', async () => {
        save.disabled = true;
        try { await api(`/api/admin/enquiries/${enquiry.id}`, { status: statusSelect.value, priority: prioritySelect.value }, 'PATCH'); status.textContent = 'Enquiry updated.'; }
        catch (error) { status.textContent = error.message; }
        finally { save.disabled = false; }
      });
      row.append(summary, statusSelect, prioritySelect, save); list.append(row);
    }
    status.textContent = `${data.enquiries.length} customer ${data.enquiries.length === 1 ? 'enquiry' : 'enquiries'}`;
  } catch (error) { status.textContent = error.message; }
}
$('#refresh-enquiries').addEventListener('click', renderAdminEnquiries);
let adminAccountsPanel;
function ensureAdminAccountsPanel() {
  if (adminAccountsPanel) return adminAccountsPanel;
  const panel = element('section', 'panel');
  const heading = element('div', 'panel-heading');
  heading.append(element('h2', '', 'Customer accounts'));
  const refresh = element('button', 'text-button', 'Refresh');
  refresh.type = 'button';
  refresh.addEventListener('click', renderAdminAccounts);
  heading.append(refresh);
  const status = element('p', 'muted');
  status.id = 'admin-accounts-status';
  status.setAttribute('role', 'status');
  const accountList = element('div');
  accountList.id = 'admin-accounts-list';
  const activityHeading = element('div', 'panel-heading');
  activityHeading.append(element('h2', '', 'Recent account activity'));
  const activityList = element('div');
  activityList.id = 'admin-auth-activity';
  panel.append(heading, status, accountList, activityHeading, activityList);
  const adminView = $('#admin-view');
  adminView.insertBefore(panel, adminView.querySelector('.admin-enquiries'));
  adminAccountsPanel = panel;
  return panel;
}
async function renderAdminAccounts() {
  if (currentUser?.role !== 'admin') return;
  ensureAdminAccountsPanel();
  const status = $('#admin-accounts-status');
  status.textContent = 'Loading customer accounts…';
  try {
    const data = await api('/api/admin/accounts', undefined, 'GET');
    if (currentUser?.role !== 'admin') return;
    const accountList = $('#admin-accounts-list');
    accountList.replaceChildren();
    if (!data.accounts.length) accountList.append(element('p', 'empty', 'No customer accounts yet.'));
    for (const account of data.accounts) {
      const row = element('div', 'queue-item');
      const lastLogin = account.lastLoginAt
        ? new Date(account.lastLoginAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })
        : 'No recorded sign-in';
      row.append(
        element('strong', '', account.name),
        element('p', '', `${account.email} · ${account.status}`),
        element('small', 'muted', `Created ${new Date(account.createdAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })} · Last sign-in ${lastLogin}`)
      );
      accountList.append(row);
    }
    const activityList = $('#admin-auth-activity');
    activityList.replaceChildren();
    if (!data.activity.length) activityList.append(element('p', 'empty', 'No account sign-ins or registrations recorded yet.'));
    for (const event of data.activity) {
      const row = element('div', 'knowledge-item');
      const label = event.action === 'auth.register' ? 'Created an account' : 'Signed in';
      row.append(
        element('strong', '', `${event.userName} · ${label}`),
        element('p', 'muted', `${event.userEmail} · ${new Date(event.createdAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}`)
      );
      activityList.append(row);
    }
    status.textContent = `${data.accounts.length} customer ${data.accounts.length === 1 ? 'account' : 'accounts'} · showing up to 100 recent sign-ins and registrations`;
  } catch (error) {
    status.textContent = error.message;
  }
}
const shipmentLifecycle = Object.keys(shipmentStatusLabels);
function formatInputDate(value) { return value ? String(value).slice(0, 10) : ''; }
$('#shipment-create-form').elements.customerId.addEventListener('change', async (event) => {
  const customerId = event.currentTarget.value;
  const vehicleSelect = $('#shipment-create-form').elements.vehicleId;
  const enquirySelect = $('#shipment-create-form').elements.enquiryId;
  vehicleSelect.replaceChildren(new Option('No vehicle linked', ''));
  enquirySelect.replaceChildren(new Option('No enquiry linked', ''));
  if (!customerId || currentUser?.role !== 'admin') return;
  try {
    const records = await api(`/api/admin/customers/${encodeURIComponent(customerId)}/records`, undefined, 'GET');
    if (event.currentTarget.value !== customerId) return;
    for (const vehicle of records.vehicles) vehicleSelect.add(new Option(`${vehicle.year ? `${vehicle.year} ` : ''}${vehicle.make} ${vehicle.model}`, vehicle.id));
    for (const enquiry of records.enquiries) enquirySelect.add(new Option(`${enquiry.reference} · ${enquiry.category} (${enquiry.status})`, enquiry.id));
  } catch (error) { $('#admin-shipment-status').textContent = error.message; }
});
async function renderAdminShipments({ preserveStatus = false } = {}) {
  if (currentUser?.role !== 'admin') return;
  const status = $('#admin-shipment-status'); status.textContent = 'Loading shipments and customers…';
  try {
    const [shipmentData, customerData] = await Promise.all([api('/api/admin/shipments'), api('/api/admin/customers')]);
    if (currentUser?.role !== 'admin') return;
    const customerSelect = $('#shipment-create-form').elements.customerId;
    customerSelect.replaceChildren(new Option('Select customer', ''));
    for (const customer of customerData.customers) customerSelect.add(new Option(`${customer.name} (${customer.email})`, customer.id));
    const list = $('#admin-shipments-list'); list.replaceChildren();
    if (!shipmentData.shipments.length) list.append(element('p', 'empty', 'No shipments have been created.'));
    for (const shipment of shipmentData.shipments) {
      const card = renderShipmentCard(shipment, true); card.classList.add('admin-shipment-item');
      const edit = element('form', 'shipment-edit');
      edit.innerHTML = `<label>Carrier<input name="carrier" maxlength="120"></label><label>Origin port<input name="originPort" maxlength="120" required></label><label>Destination port<input name="destinationPort" maxlength="120" required></label><label>Departure date<input name="departureDate" type="date"></label><label>Estimated arrival<input name="estimatedArrivalDate" type="date"></label><button class="text-button" type="submit">Save shipment details</button>`;
      edit.elements.carrier.value = shipment.carrier || ''; edit.elements.originPort.value = shipment.originPort; edit.elements.destinationPort.value = shipment.destinationPort; edit.elements.departureDate.value = formatInputDate(shipment.departureDate); edit.elements.estimatedArrivalDate.value = formatInputDate(shipment.estimatedArrivalDate);
      edit.addEventListener('submit', async (event) => {
        event.preventDefault(); const button = edit.querySelector('button'); button.disabled = true;
        try {
          const values = Object.fromEntries(new FormData(edit));
          for (const key of ['carrier', 'departureDate', 'estimatedArrivalDate']) if (!values[key]) values[key] = null;
          await api(`/api/admin/shipments/${shipment.id}`, values, 'PATCH'); status.textContent = 'Shipment details updated.'; await renderAdminShipments({ preserveStatus: true });
        } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
      });
      card.append(edit);
      const milestoneForm = element('form', 'shipment-milestone-form');
      const select = element('select'); select.name = 'status'; select.setAttribute('aria-label', `Next milestone for ${shipment.trackingReference}`);
      const next = shipmentLifecycle[shipmentLifecycle.indexOf(shipment.status) + 1];
      if (next) select.add(new Option(`Next: ${shipmentStatusLabels[next]}`, next)); else select.add(new Option('Shipment lifecycle complete', '', true, true));
      const note = element('input'); note.name = 'note'; note.maxLength = 1000; note.placeholder = 'Optional manual update note'; note.setAttribute('aria-label', `Milestone note for ${shipment.trackingReference}`);
      const add = element('button', 'primary', 'Append milestone'); add.type = 'submit'; add.disabled = !next;
      milestoneForm.append(select, note, add);
      milestoneForm.addEventListener('submit', async (event) => {
        event.preventDefault(); add.disabled = true;
        try { await api(`/api/admin/shipments/${shipment.id}/milestones`, { status: select.value, note: note.value || undefined }); status.textContent = 'Manual milestone appended.'; await renderAdminShipments({ preserveStatus: true }); }
        catch (error) { status.textContent = error.message; add.disabled = false; }
      });
      card.append(milestoneForm); list.append(card);
    }
    if (!preserveStatus) status.textContent = `${shipmentData.shipments.length} shipment${shipmentData.shipments.length === 1 ? '' : 's'} · all updates are manual`;
  } catch (error) { status.textContent = error.message; }
}
$('#refresh-shipments').addEventListener('click', renderAdminShipments);
$('#shipment-create-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const status = $('#admin-shipment-status'); button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  for (const key of ['carrier', 'departureDate', 'estimatedArrivalDate', 'vehicleId', 'enquiryId']) if (!values[key]) delete values[key];
  try {
    const result = await api('/api/admin/shipments', values);
    form.reset(); status.textContent = `Shipment created with tracking reference ${result.shipment.trackingReference}.`;
    await renderAdminShipments({ preserveStatus: true });
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
function bubble(text, sender = 'bot') {
  const node = element('div', `message ${sender}-message`);
  if (text) node.append(element('p', '', text));
  const time = element('time', '', new Date().toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }));
  node.append(time); messages.append(node); messages.scrollTop = messages.scrollHeight; return node;
}
function record(intent, message) { activity({ intent, message }); }
function greet() { bubble('Karibu! 👋 I’m your Portside import assistant.\n\nI can help you explore a landed-cost breakdown, compare import timing, check a VIN or chassis number, or track a shipment. Choose a service below to get started.\n\nImport tax figures are only a historical KRA 2021 reference, not current rates; no live KRA connection is configured and no final customs total is provided. Timing advice is illustrative. Shipment milestones are entered manually; there is no live carrier connection. Vehicle history requires a supported provider; none is configured yet.'); }
function rows(node, entries) { for (const [name, value] of entries) { const row = element('div', `cost-row${name === 'Demo total' ? ' total' : ''}`); row.append(element('span', '', name), element('span', '', value)); node.insertBefore(row, node.lastChild); } messages.scrollTop = messages.scrollHeight; }
function addMessageDetail(node, detail) { node.insertBefore(detail, node.lastChild); messages.scrollTop = messages.scrollHeight; }
function displayProviderValue(value) {
  if (value === null || value === undefined || value === '') return 'Not supplied by provider';
  if (typeof value !== 'object') return String(value);
  if (value.status === 'unavailable') return 'Unavailable from provider';
  const content = value.summary ?? value.value ?? value.amount ?? value.status;
  if (content === undefined) return 'Provider returned information';
  const unit = value.unit ?? value.currency;
  return `${content}${unit ? ` ${unit}` : ''}`;
}
function renderVehicleLookup(result) {
  if (result.status === 'unavailable' || result.status === 'not_found') {
    const title = result.status === 'not_found' ? 'No provider record found' : 'Lookup unavailable';
    const card = bubble(`${title} · ${result.identifierType.toUpperCase()} ${result.identifier}`);
    addMessageDetail(card, element('p', 'caption', result.message));
    const fields = element('div', 'lookup-fields');
    for (const label of ['Make, model, year and engine', 'Mileage', 'Damage and accident records', 'Theft and ownership history', 'Vehicle photos', 'Market value']) {
      const value = result.status === 'not_found' ? 'No matching provider record' : result.reason === 'provider_not_configured' ? 'Unavailable · no provider configured' : `Unavailable · ${result.provider?.name || 'provider'}`;
      const row = element('div', 'lookup-field'); row.append(element('strong', '', label), element('span', '', value)); fields.append(row);
    }
    addMessageDetail(card, fields);
    addMessageDetail(card, element('p', 'caption', 'No vehicle history or specifications were returned. Portside does not infer a clean history from missing data.'));
    return;
  }
  const data = result.data || {};
  const vehicle = data.vehicle || {};
  const card = bubble(`Provider response · ${result.identifierType.toUpperCase()} ${result.identifier}`);
  const specs = [
    ['Make', vehicle.make], ['Model', vehicle.model], ['Year', vehicle.year], ['Trim', vehicle.trim],
    ['Engine', vehicle.engineCapacityCc ? `${vehicle.engineCapacityCc} cc` : vehicle.engine], ['Fuel', vehicle.fuelType], ['Transmission', vehicle.transmission]
  ];
  const fieldList = element('div', 'lookup-fields');
  for (const [label, value] of specs) { const row = element('div', 'lookup-field'); row.append(element('strong', '', label), element('span', '', displayProviderValue(value))); fieldList.append(row); }
  addMessageDetail(card, fieldList);
  const history = data.history || {};
  const historyList = element('div', 'lookup-fields');
  for (const [key, label] of [['mileage', 'Mileage'], ['damage', 'Damage'], ['accidents', 'Accidents'], ['theft', 'Theft'], ['ownership', 'Ownership history']]) {
    const row = element('div', 'lookup-field'); row.append(element('strong', '', label), element('span', '', displayProviderValue(history[key]))); historyList.append(row);
  }
  addMessageDetail(card, historyList);
  if (data.marketValue) addMessageDetail(card, element('p', '', `Market value · ${displayProviderValue(data.marketValue)}`));
  if (Array.isArray(data.photos) && data.photos.length) {
    const photoList = element('div', 'lookup-photos');
    for (const photo of data.photos.slice(0, 6)) {
      try {
        const url = new URL(photo.url);
        if (!['https:', 'http:'].includes(url.protocol)) continue;
        const link = element('a', '', photo.caption || 'View provider photo'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; photoList.append(link);
      } catch { /* Ignore malformed provider photo links. */ }
    }
    if (photoList.childNodes.length) addMessageDetail(card, photoList);
  }
  addMessageDetail(card, element('p', 'caption', `Provider: ${result.provider?.name || 'Configured vehicle provider'}. Provider-supplied information is not independently verified by Portside; missing records do not establish that no incident occurred.`));
  if (currentUser?.role === 'customer' && typeof vehicle.make === 'string' && vehicle.make.trim() && typeof vehicle.model === 'string' && vehicle.model.trim()) {
    const save = element('button', 'primary lookup-save', 'Save vehicle to my account'); save.type = 'button';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const payload = { make: vehicle.make, model: vehicle.model, vin: result.identifier };
        if (Number.isInteger(vehicle.year)) payload.year = vehicle.year;
        if (Number.isInteger(vehicle.engineCapacityCc)) payload.engineCapacityCc = vehicle.engineCapacityCc;
        if (typeof vehicle.fuelType === 'string') payload.fuelType = vehicle.fuelType;
        await api('/api/vehicles', payload);
        save.textContent = 'Saved to my vehicles';
      } catch (error) { save.textContent = error.message; }
      finally { save.disabled = false; }
    });
    addMessageDetail(card, save);
  }
}
const formatKsh = (value) => value === null || value === undefined ? 'Unavailable' : money(value);
function renderImportEstimate(result) {
  const card = bubble(result.rulesetStatus === 'historical_reference'
    ? 'Historical reference estimate · not current KRA rates'
    : result.status === 'complete_estimate' ? 'Configured import estimate' : 'Partial import-cost estimate');
  addMessageDetail(card, element('p', '', `${result.vehicle.year} ${result.vehicle.make} ${result.vehicle.model} · ${result.vehicle.fuelType}${result.vehicle.engineCapacityCc ? ` · ${result.vehicle.engineCapacityCc} cc` : ''} · Purchase/export country: ${result.vehicle.countryOfExport}`));
  const fx = result.currencyConversion;
  const fxMessage = fx.status === 'not_required'
    ? 'All entered amounts are in KSh.'
    : fx.status === 'user_supplied'
      ? `User-supplied rate: 1 ${fx.currency} = KSh ${Number(fx.rate).toLocaleString('en-KE')} · ${fx.date} · Source: ${fx.source}`
      : `KSh conversion unavailable for ${fx.currency}; enter a rate with its date and source to convert.`;
  addMessageDetail(card, element('p', 'caption', fxMessage));
  const lines = element('div', 'estimate-lines');
  for (const line of result.lines) {
    const row = element('div', `estimate-line estimate-${line.category}`);
    const details = element('div'); details.append(element('strong', '', line.label));
    let statusText = line.status.replaceAll('_', ' ');
    if (line.category === 'entered_cost') {
      const entered = line.enteredAmount === null ? 'Not provided' : `${line.currency} ${Number(line.enteredAmount).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
      statusText = `${entered} · ${formatKsh(line.amountKsh)}`;
    } else if (line.rate !== null) statusText = `${(line.rate * 100).toLocaleString('en-KE')}% · ${line.effectiveDate ? `Effective ${line.effectiveDate}` : line.sourceDate ? `Source dated ${line.sourceDate}` : ''} · ${line.source || ''}`;
    else if (line.source) statusText += ` · ${line.source}`;
    details.append(element('small', '', statusText));
    const value = line.category === 'valuation' ? line.status === 'user_supplied' ? formatKsh(line.amountKsh) : 'Not established' : formatKsh(line.amountKsh);
    row.append(details, element('strong', '', value)); lines.append(row);
  }
  addMessageDetail(card, lines);
  const subtotal = element('div', 'estimate-total estimate-subtotal');
  subtotal.append(element('span', '', 'Subtotal of entered costs (not a landed total)'), element('strong', '', formatKsh(result.knownCostsSubtotalKsh)));
  addMessageDetail(card, subtotal);
  const total = element('div', `estimate-total${result.totalKsh === null ? ' estimate-incomplete' : ''}`);
  total.append(element('span', '', 'Estimated total'), element('strong', '', result.totalKsh === null ? 'Unavailable · rules or inputs incomplete' : money(result.totalKsh)));
  addMessageDetail(card, total);
  if (result.missingInformation.length) {
    addMessageDetail(card, element('strong', '', 'Missing or unconfigured'));
    const missing = element('ul', 'estimate-notes');
    for (const item of result.missingInformation) missing.append(element('li', '', item));
    addMessageDetail(card, missing);
  }
  const assumptions = element('ul', 'estimate-notes');
  for (const item of result.assumptions) assumptions.append(element('li', '', item));
  addMessageDetail(card, assumptions);
  if (result.sourceReferences?.length) {
    const sources = element('div', 'estimate-sources'); sources.append(element('strong', '', 'Official references'));
    for (const source of result.sourceReferences) {
      const link = element('a', '', source.label); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; sources.append(link);
    }
    addMessageDetail(card, sources);
  }
}
const models = ['Toyota Harrier', 'Toyota Prado', 'Mazda CX-5', 'Nissan X-Trail'];
const demoCosts = { 'Toyota Harrier': 1850000, 'Toyota Prado': 3200000, 'Mazda CX-5': 1400000, 'Nissan X-Trail': 1250000 };
const modelsByMake = {
  Toyota: ['Harrier', 'Prado'],
  Mazda: ['CX-5'],
  Nissan: ['X-Trail'],
  BMW: ['M Series', 'X Series']
};
const vehiclePresets = [
  { make: 'Toyota', model: 'Harrier', year: 2020, engineCapacityCc: 2000, fuelType: 'petrol', purchasePrice: demoCosts['Toyota Harrier'] },
  { make: 'Toyota', model: 'Prado', year: 2019, engineCapacityCc: 2800, fuelType: 'diesel', purchasePrice: demoCosts['Toyota Prado'] },
  { make: 'Mazda', model: 'CX-5', year: 2020, engineCapacityCc: 2000, fuelType: 'petrol', purchasePrice: demoCosts['Mazda CX-5'] },
  { make: 'Nissan', model: 'X-Trail', year: 2020, engineCapacityCc: 2000, fuelType: 'petrol', purchasePrice: demoCosts['Nissan X-Trail'] }
];
function startFlow(action, log = true) {
  if (!currentUser) return;
  const names = { quote: 'Get a landed-cost quote', advisor: 'Compare import timing', vin: 'Look up a vehicle', tracking: 'Track a shipment' };
  if (log) { bubble(names[action], 'user'); record(action, names[action]); }
  const node = bubble(action === 'quote' ? 'Enter the vehicle and purchase details for an itemized estimate. Tax figures use a historical KRA 2021 reference only; charges may be unavailable, no live KRA connection exists, and the app will not provide a final customs total.' : action === 'advisor' ? 'Choose a vehicle to explore a sample result. The backend will calculate costs from these inputs later.' : action === 'vin' ? 'Enter a VIN or chassis number. Vehicle-history details require a supported data provider.' : 'Enter your Portside tracking reference to view shipment milestones entered by an administrator. No carrier integration or live vessel tracking is configured.');
  const form = element('form', 'flow-form');
  if (action === 'quote') {
    form.classList.add('import-estimator');
    form.innerHTML = `<div class="fields"><label class="wide-field">Vehicle preset<select name="vehiclePreset"><option value="">Choose a vehicle or enter details manually</option></select><small>Selecting a preset fills vehicle details and editable sample cost inputs only.</small></label><label>Make<select name="makeChoice" required><option value="">Choose make</option><option>Toyota</option><option>Mazda</option><option>Nissan</option><option>BMW</option><option value="__custom__">Other / enter manually</option></select><input name="customMake" maxlength="80" placeholder="Enter make" hidden></label><label>Model<select name="modelChoice" required disabled><option value="">Choose make first</option></select><input name="customModel" maxlength="100" placeholder="Enter model" hidden></label><label>Year of manufacture<input name="year" type="number" min="1886" max="${new Date().getUTCFullYear()}" required></label><label>Engine capacity (cc), if applicable<input name="engineCapacityCc" type="number" min="1" max="20000"></label><label>Fuel type<select name="fuelType" required><option value="">Choose fuel</option><option value="petrol">Petrol</option><option value="diesel">Diesel</option><option value="hybrid">Hybrid</option><option value="electric">Electric</option><option value="other">Other / unknown</option></select></label><label>Purchase price<input name="purchasePrice" type="number" min="0.01" step="0.01" required></label><label>Currency<select name="currency" required><option>KES</option><option>USD</option><option>JPY</option><option>GBP</option><option>EUR</option><option>AED</option><option>ZAR</option><option>CAD</option><option>AUD</option><option>SGD</option><option>INR</option><option>CNY</option><option>HKD</option></select></label><label>Country of purchase/export<input name="countryOfExport" maxlength="80" required></label><label>Freight cost (optional)<input name="freightCost" type="number" min="0" step="0.01"></label><label>Insurance cost (optional)<input name="insuranceCost" type="number" min="0" step="0.01"></label><p class="caption wide-field preset-cost-help">Preset costs are illustrative KSh placeholders, not live vehicle prices, freight quotes, or insurance quotes. Replace them with actual amounts.</p><label class="wide-field">KRA/clearing-agent customs value in KSh (if known)<input name="customsValueKsh" type="number" min="0.01" step="0.01"><small>Do not estimate this from purchase price; enter only an assessed/reference value supplied to you. Vehicle presets never fill this value.</small></label><div class="fx-fields wide-field" hidden><label>KSh per 1 unit of currency<input name="exchangeRate" type="number" min="0.000001" step="0.000001"></label><label>Exchange-rate date<input name="exchangeRateDate" type="date"></label><label>Exchange-rate source<input name="exchangeRateSource" maxlength="200" placeholder="For example, the KRA weekly rate sheet"></label></div></div><p class="caption fx-help" hidden>Foreign amounts are not converted unless you provide a rate, date, and source. User-entered rates are not represented as official KRA customs rates.</p>`;
    const presetSelect = form.elements.vehiclePreset;
    const makeSelect = form.elements.makeChoice;
    const modelSelect = form.elements.modelChoice;
    const customMake = form.elements.customMake;
    const customModel = form.elements.customModel;
    const setModelOptions = () => {
      const make = makeSelect.value;
      const availableModels = modelsByMake[make] || [];
      modelSelect.replaceChildren(new Option(availableModels.length ? 'Choose model' : 'Enter model manually', ''));
      for (const model of availableModels) modelSelect.add(new Option(model, model));
      if (availableModels.length) modelSelect.add(new Option('Other model / enter manually', '__custom__'));
      modelSelect.disabled = make === '' || make === '__custom__' || availableModels.length === 0;
      customMake.hidden = make !== '__custom__';
      customMake.required = make === '__custom__';
      const freeModel = make === '__custom__' || (make !== '' && availableModels.length === 0);
      customModel.hidden = !freeModel;
      customModel.required = freeModel;
      modelSelect.required = make !== '' && make !== '__custom__' && availableModels.length > 0;
    };
    makeSelect.addEventListener('change', () => { presetSelect.value = ''; setModelOptions(); });
    modelSelect.addEventListener('change', () => {
      presetSelect.value = '';
      customModel.hidden = modelSelect.value !== '__custom__';
      customModel.required = modelSelect.value === '__custom__';
    });
    for (const [index, preset] of vehiclePresets.entries()) presetSelect.add(new Option(`${preset.make} ${preset.model}`, String(index)));
    presetSelect.addEventListener('change', () => {
      if (presetSelect.value === '') return;
      const preset = vehiclePresets[Number(presetSelect.value)];
      if (!preset) return;
      makeSelect.value = preset.make;
      setModelOptions();
      modelSelect.value = preset.model;
      customModel.hidden = true;
      customModel.required = false;
      form.elements.year.value = String(preset.year);
      form.elements.engineCapacityCc.value = String(preset.engineCapacityCc);
      form.elements.fuelType.value = preset.fuelType;
      form.elements.purchasePrice.value = String(preset.purchasePrice);
      form.elements.currency.value = 'KES';
      form.elements.countryOfExport.value = 'Japan';
      form.elements.freightCost.value = '200000';
      form.elements.insuranceCost.value = '20000';
      form.elements.customsValueKsh.value = '';
    });
    setModelOptions();
    const currency = form.elements.currency;
    const fxFields = form.querySelector('.fx-fields'); const fxHelp = form.querySelector('.fx-help');
    const updateCurrencyFields = () => { fxFields.hidden = currency.value === 'KES'; fxHelp.hidden = currency.value === 'KES'; };
    currency.addEventListener('change', updateCurrencyFields); updateCurrencyFields();
  } else if (action === 'advisor') {
    form.innerHTML = '<div class="fields"><label>Vehicle model<select name="model"></select></label><label>First registration month<input type="month" name="registration" min="2000-01" max="2026-10" value="2019-12" required></label><label>Engine capacity (cc)<input type="number" name="engine" min="600" max="8000" value="2000" required></label><label>Fuel type<select name="fuel"><option>Petrol</option><option>Diesel</option><option>Hybrid</option><option>Electric</option></select></label></div>';
    for (const model of models) form.elements.model.append(new Option(model, model));
  } else {
    const label = element('label', '', action === 'vin' ? 'VIN or chassis number' : 'Portside shipment reference');
    const input = element('input'); input.name = 'reference'; input.required = true; input.maxLength = 40; input.autocomplete = 'off'; input.placeholder = action === 'vin' ? '17-character VIN or chassis number' : 'PST-SHP-2026-ABC12345'; label.append(input); form.append(label);
    if (action === 'vin') form.append(element('p', 'caption', 'VINs must contain 17 characters and cannot use I, O, or Q. Chassis numbers may be 5–40 letters, numbers, or hyphens.'));
  }
  const button = element('button', 'primary', action === 'quote' ? 'Estimate import costs' : action === 'advisor' ? 'Compare sample costs' : action === 'vin' ? 'Look up vehicle' : 'Look up shipment'); button.type = 'submit'; form.append(button); node.insertBefore(form, node.lastChild);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(form));
    if (!currentUser) return;
    if (data.model && action === 'advisor') activity({ model: data.model });
    if (action === 'quote') {
      data.make = data.makeChoice === '__custom__' ? data.customMake : data.makeChoice;
      data.model = data.makeChoice === '__custom__' || data.modelChoice === '__custom__'
        ? data.customModel
        : data.modelChoice;
      delete data.makeChoice;
      delete data.modelChoice;
      delete data.customMake;
      delete data.customModel;
      bubble(`${data.year} ${data.make} ${data.model} · ${data.currency} ${data.purchasePrice} · ${data.countryOfExport}`, 'user');
      button.disabled = true; button.textContent = 'Calculating…';
      const loading = bubble('Calculating the entered costs against the currently configured rules…');
      const payload = { ...data };
      for (const key of ['year', 'engineCapacityCc', 'purchasePrice', 'freightCost', 'insuranceCost', 'exchangeRate', 'customsValueKsh']) {
        if (payload[key] === '') delete payload[key]; else if (payload[key] !== undefined) payload[key] = Number(payload[key]);
      }
      try { const result = await api('/api/import-cost-estimate', payload); loading.remove(); renderImportEstimate(result); }
      catch (error) { loading.remove(); bubble(`Estimate could not be calculated: ${error.message}`); }
      finally { button.disabled = false; button.textContent = 'Estimate import costs'; }
      return;
    }
    bubble(data.model ? `${data.model} · ${data.registration} · ${data.engine} cc · ${data.fuel}` : data.reference, 'user');
    if (action === 'advisor') {
      const result = bubble(`Sample timing comparison · ${data.model}`); const samplePrice = demoCosts[data.model];
      rows(result, [['Now (illustration)', money(samplePrice)], ['+1 month (illustration)', money(samplePrice)], ['+2 months (illustration)', money(samplePrice * .9)]]);
      result.insertBefore(element('p', 'caption', 'Illustrative vehicle-price scenario only. It is not an import-cost estimate, customs valuation, or prediction.'), result.lastChild);
    } else if (action === 'vin') {
      button.disabled = true; button.textContent = 'Looking up…';
      try {
        const result = await api('/api/vehicle-lookup', { identifier: data.reference });
        renderVehicleLookup(result);
        record('vin', 'Vehicle lookup requested');
      } catch (error) { bubble(`Vehicle lookup could not be completed: ${error.message}`); }
      finally { button.disabled = false; button.textContent = 'Look up vehicle'; }
    } else {
      button.disabled = true; button.textContent = 'Looking up…';
      try {
        const result = await api(`/api/shipments/${encodeURIComponent(data.reference.trim())}`, undefined, 'GET');
        const card = bubble(`Shipment · ${result.shipment.trackingReference}`);
        addMessageDetail(card, renderShipmentCard(result.shipment, false));
        record('tracking', 'Shipment tracking reference checked');
      } catch (error) { bubble(`Shipment could not be found or loaded: ${error.message}`); }
      finally { button.disabled = false; button.textContent = 'Look up shipment'; }
    }
    messages.scrollTop = messages.scrollHeight;
  });
  messages.scrollTop = messages.scrollHeight;
}
async function handleMessage(text) {
  if (!currentUser) return;
  bubble(text, 'user');
  try { state.knowledge = (await api('/api/knowledge')).knowledge; } catch (error) { if (currentUser) bubble(error.message); return; }
  if (!currentUser) return;
  const key = normalize(text); const known = state.knowledge.find((item) => normalize(item.question) === key);
  if (known) { record('knowledge', text); bubble(known.answer); return; }
  let intent;
  if (/\b(track|tracking|shipment|container|bl)\b/.test(key)) intent = 'tracking';
  else if (/\b(vin|history|accident|odometer|auction)\b/.test(key)) intent = 'vin';
  else if (/\b(when|timing|wait|depreciation|advisor)\b/.test(key)) intent = 'advisor';
  else if (/\b(quote|cost|duty|tax|price)\b/.test(key)) intent = 'quote';
  else if (/\b(hello|hi|hey|help|start)\b/.test(key)) intent = 'help';
  record(intent || 'unresolved', text);
  if (intent === 'help') { bubble('I can help with landed costs, timing advice, vehicle history and shipment tracking. Choose a shortcut or type “quote”, “timing”, “VIN” or “track”.'); return; }
  if (intent) { startFlow(intent, false); return; }
  bubble('I don’t have an answer for that yet. I’ve added your question to the demo admin queue. Once an admin saves an answer, ask the same question again to try it.');
}
$('#chat-form').addEventListener('submit', (event) => { event.preventDefault(); const input = $('#message'); const text = input.value.trim(); if (!text) return; input.value = ''; handleMessage(text); input.focus(); });
for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => startFlow(button.dataset.action));
$('#clear-chat').addEventListener('click', () => { messages.replaceChildren(); greet(); });
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => { const admin = button.dataset.view === 'admin'; if (!currentUser || (admin && currentUser.role !== 'admin')) return; $('#importer-view').hidden = admin; $('#admin-view').hidden = !admin; for (const nav of document.querySelectorAll('[data-view]')) nav.classList.toggle('active', nav === button); if (admin) renderAdmin(); });
async function renderAdmin() {
  if (currentUser?.role !== 'admin') return;
  await Promise.all([renderAdminAccounts(), renderAdminEnquiries(), renderAdminShipments()]);
  try { await pendingActivity; const result = await api('/api/admin'); if (currentUser?.role !== 'admin') return; state = result; } catch (error) { $('#unresolved-queue').replaceChildren(element('p', 'empty', error.message)); return; }
  const metrics = $('#metrics'); metrics.replaceChildren();
  const items = [['Total queries', state.queries.length, 'Chat messages and service requests'], ['Quote requests', state.queries.filter((q) => q.intent === 'quote').length, 'Requests for a cost breakdown'], ['Unresolved queue', state.unresolved.length, 'Questions awaiting an answer'], ['Drop-off rate', '—', 'Requires backend session completion tracking']];
  for (const [label, value, caption] of items) { const card = element('div', 'metric'); card.append(element('small', '', label), element('strong', '', String(value)), element('p', '', caption)); metrics.append(card); }
  const counts = ['quote', 'advisor', 'vin', 'tracking', 'unresolved'].map((intent) => state.queries.filter((q) => q.intent === intent).length); const max = Math.max(1, ...counts);
  const chart = $('#activity-chart'); chart.replaceChildren(); ['Quotes', 'Timing', 'VIN', 'Tracking', 'Unknown'].forEach((label, index) => { const col = element('div', 'chart-column'); const bar = element('div', 'chart-bar'); bar.style.height = `${counts[index] / max * 100}px`; col.append(element('span', '', String(counts[index])), bar, element('span', '', label)); chart.append(col); });
  chart.setAttribute('aria-label', `Query counts: ${counts.join(', ')} for quotes, timing, VIN, tracking, unanswered`);
  const modelChart = $('#model-chart'); modelChart.replaceChildren(); const entries = Object.entries(state.models).sort((a, b) => b[1] - a[1]);
  if (!entries.length) modelChart.append(element('p', 'empty', 'Preview a quote or timing comparison to see requested models here.'));
  for (const [model, count] of entries) { const row = element('div', 'model-row'); const label = element('div'); label.append(element('span', '', model), element('span', '', String(count))); const track = element('div', 'model-track'); const fill = element('div', 'model-fill'); fill.style.width = `${count / entries[0][1] * 100}%`; track.append(fill); row.append(label, track); modelChart.append(row); }
  $('#queue-count').textContent = `${state.unresolved.length} pending`; const queue = $('#unresolved-queue'); queue.replaceChildren();
  if (!state.unresolved.length) queue.append(element('p', 'empty', 'All caught up. Unrecognized chat questions will appear here.'));
  for (const item of state.unresolved) { const wrapper = element('div', 'queue-item'); wrapper.append(element('p', '', item.question)); const form = element('form'); const answer = element('textarea'); answer.required = true; answer.rows = 3; answer.maxLength = 2000; answer.placeholder = 'Write a helpful answer…'; answer.setAttribute('aria-label', `Answer to ${item.question}`); const button = element('button', 'primary', 'Save answer'); button.type = 'submit'; form.append(answer, button); wrapper.append(form); queue.append(wrapper); form.addEventListener('submit', async (event) => { event.preventDefault(); if (!answer.value.trim() || currentUser?.role !== 'admin') return; button.disabled = true; try { await api('/api/answers', { id: item.id, answer: answer.value.trim() }); await renderAdmin(); } catch (error) { answer.setCustomValidity(error.message); answer.reportValidity(); answer.setCustomValidity(''); } finally { button.disabled = false; } }); }
  const knowledge = $('#knowledge-list'); knowledge.replaceChildren(); if (!state.knowledge.length) knowledge.append(element('p', 'empty', 'No saved answers yet. Answer a question in the queue to get started.'));
  for (const item of state.knowledge) { const row = element('div', 'knowledge-item'); row.append(element('strong', '', item.question), element('p', 'muted', item.answer)); knowledge.append(row); }
}
api('/api/auth/me').then(({ user }) => showApp(user)).catch(() => showLogin());
