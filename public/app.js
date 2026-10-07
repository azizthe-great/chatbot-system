'use strict';
const $ = (selector) => document.querySelector(selector);
const messages = $('#messages');
let currentUser = null;
let state = { queries: [], unresolved: [], knowledge: [], models: {} };
let pendingActivity = Promise.resolve();
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/api/login') showLogin(); throw new Error(result.error || 'Request failed.'); }
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
}
function showApp(user) {
  currentUser = user; $('#login-view').hidden = true; $('#app-nav').hidden = false; $('#account-menu').hidden = false;
  $('#account-name').textContent = `${user.username} · ${user.role}`;
  $('#admin-nav').hidden = user.role !== 'admin';
  $('#importer-view').hidden = false; $('#admin-view').hidden = true;
  for (const nav of document.querySelectorAll('[data-view]')) nav.classList.toggle('active', nav.dataset.view === 'importer');
  messages.replaceChildren(); greet();
}
function activity(data) {
  pendingActivity = pendingActivity.then(() => api('/api/activity', data)).catch((error) => { if (currentUser) bubble(`Could not save activity: ${error.message}`); });
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; $('#login-error').hidden = true;
  try { const result = await api('/api/login', Object.fromEntries(new FormData(event.target))); event.target.reset(); showApp(result.user); }
  catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; }
  finally { button.disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  try { await pendingActivity; await api('/api/logout', {}); showLogin(); }
  catch (error) { bubble(`Could not sign out: ${error.message}`); }
});
const money = (value) => `Ksh ${Number(value).toLocaleString('en-KE')}`;
const normalize = (value) => value.toLowerCase().replace(/[?!.,]/g, '').replace(/\s+/g, ' ').trim();
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function bubble(text, sender = 'bot') {
  const node = element('div', `message ${sender}-message`);
  if (text) node.append(element('p', '', text));
  const time = element('time', '', new Date().toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }));
  node.append(time); messages.append(node); messages.scrollTop = messages.scrollHeight; return node;
}
function record(intent, message) { activity({ intent, message }); }
function greet() { bubble('Karibu! 👋 I’m your Portside import assistant.\n\nI can help you explore a landed-cost breakdown, compare import timing, check vehicle history, or track a shipment. Choose a service below to get started.\n\nEverything here uses illustrative demo data.'); }
function rows(node, entries) { for (const [name, value] of entries) { const row = element('div', `cost-row${name === 'Demo total' ? ' total' : ''}`); row.append(element('span', '', name), element('span', '', value)); node.insertBefore(row, node.lastChild); } messages.scrollTop = messages.scrollHeight; }
const models = ['Toyota Harrier', 'Toyota Prado', 'Mazda CX-5', 'Nissan X-Trail'];
const demoCosts = { 'Toyota Harrier': 1850000, 'Toyota Prado': 3200000, 'Mazda CX-5': 1400000, 'Nissan X-Trail': 1250000 };
function startFlow(action, log = true) {
  if (!currentUser) return;
  const names = { quote: 'Get a landed-cost quote', advisor: 'Compare import timing', vin: 'Check vehicle history', tracking: 'Track a shipment' };
  if (log) { bubble(names[action], 'user'); record(action, names[action]); }
  const node = bubble(action === 'quote' || action === 'advisor' ? 'Choose a vehicle to explore a sample result. The backend will calculate costs from these inputs later.' : action === 'vin' ? 'Enter the sample VIN JTMBE31V006123456 to view a mock vehicle record.' : 'Enter the sample reference BL-KE-1024 or container MSKU1234567 to view a mock shipment.');
  const form = element('form', 'flow-form');
  if (action === 'quote' || action === 'advisor') {
    form.innerHTML = '<div class="fields"><label>Vehicle model<select name="model"></select></label><label>First registration month<input type="month" name="registration" min="2000-01" max="2026-10" value="2019-12" required></label><label>Engine capacity (cc)<input type="number" name="engine" min="600" max="8000" value="2000" required></label><label>Fuel type<select name="fuel"><option>Petrol</option><option>Diesel</option><option>Hybrid</option><option>Electric</option></select></label></div>';
    for (const model of models) form.elements.model.append(new Option(model, model));
  } else {
    const label = element('label', '', action === 'vin' ? 'Vehicle identification number' : 'BL / container number');
    const input = element('input'); input.name = 'reference'; input.required = true; input.maxLength = 40; input.placeholder = action === 'vin' ? 'JTMBE31V006123456' : 'BL-KE-1024'; label.append(input); form.append(label);
  }
  const button = element('button', 'primary', action === 'quote' ? 'Preview breakdown' : action === 'advisor' ? 'Compare sample costs' : 'Look up demo record'); button.type = 'submit'; form.append(button); node.insertBefore(form, node.lastChild);
  form.addEventListener('submit', (event) => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(form));
    if (!currentUser) return;
    if (data.model) activity({ model: data.model });
    bubble(data.model ? `${data.model} · ${data.registration} · ${data.engine} cc · ${data.fuel}` : data.reference, 'user');
    if (action === 'quote') {
      const base = demoCosts[data.model];
      const result = bubble(`Sample breakdown · ${data.model}`);
      // UI fixtures only: these proportions are not a tax schedule or duty engine.
      rows(result, [['Customs value', money(base)], ['Import duty', money(base * .25)], ['Excise', money(base * .2)], ['VAT', money(base * .16)], ['IDF', money(base * .02)], ['RDL', money(base * .015)], ['Demo total', money(base * 1.645)]]);
      result.insertBefore(element('p', 'caption', 'Fixed UI fixture for this model. Registration, engine and fuel are captured for the future backend but do not affect this preview. Not a KRA quote; port, clearing and other fees are excluded.'), result.lastChild);
    } else if (action === 'advisor') {
      const result = bubble(`Sample timing comparison · ${data.model}`); const total = demoCosts[data.model] * 1.645;
      rows(result, [['Now (sample)', money(total)], ['+1 month (sample)', money(total)], ['+2 months (sample)', money(total * .9)]]);
      result.insertBefore(element('p', 'caption', `Example only: a hypothetical band crossing at +2 months shows ${money(total * .1)} lower cost. This is a fixed visual scenario, not an eligibility assessment. Editable bands and registration-based calculations come with the backend.`), result.lastChild);
    } else if (action === 'vin') {
      if (data.reference.trim().toUpperCase() !== 'JTMBE31V006123456') { bubble('No demo record found. Try JTMBE31V006123456.'); return; }
      const result = bubble('Mock vehicle history · Toyota Harrier'); rows(result, [['Odometer', '68,400 km'], ['Accident history', 'None in sample record'], ['Auction grade', '4.5'], ['First registration', 'December 2019']]); result.insertBefore(element('p', 'caption', 'Fictional record. No live VIN or auction service is connected.'), result.lastChild);
    } else {
      if (!['BL-KE-1024', 'MSKU1234567'].includes(data.reference.trim().toUpperCase())) { bubble('No demo shipment found. Try BL-KE-1024 or MSKU1234567.'); return; }
      const result = bubble('Mock shipment · In transit'); rows(result, [['Route', 'Yokohama → Mombasa'], ['Departed (sample)', '24 Sep 2026'], ['Estimated arrival (sample)', '18 Oct 2026'], ['Latest milestone', 'Vessel departed origin port']]); result.insertBefore(element('p', 'caption', 'Static demo timeline. No carrier connection or live tracking.'), result.lastChild);
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
api('/api/session').then(({ user }) => showApp(user)).catch(() => showLogin());
