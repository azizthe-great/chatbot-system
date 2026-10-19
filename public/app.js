'use strict';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const node = (tag, className, content) => { const el = document.createElement(tag); if (className) el.className = className; if (content !== undefined) el.textContent = content; return el; };
const money = (amount) => `Ksh ${Number(amount).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
const date = (value) => new Date(value).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });
const id = () => crypto.randomUUID();
let user = null, conversation = null, catalog = null, epoch = 0, busy = false, creating = null, activeView = 'importer';
let authMode = 'login', recoveryCode = '', pendingUser = null, libraryPage = 1, quotePage = 1, queuePage = 1, knowledgePage = 1, adminVersion = 0, libraryVersion = 0;
let googleEnabled = null, googleConfigFailed = false;
const controllers = new Set();
function notify(message, error = false) { const el = $('#notice'); el.textContent = message; el.className = `notice${error ? ' error' : ''}`; el.hidden = !message; }
function feedback(el, message, error = false) { el.textContent = message; el.className = error ? 'error' : 'success'; }
async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  const controller = new AbortController(); if (path !== '/api/auth/config') controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { method, credentials: 'same-origin', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: controller.signal });
    let result; try { result = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please retry.'); }
    if (!response.ok) { if (response.status === 401 && user) showLogin('Your session has expired. Sign in to continue; saved work is in your library.'); throw new Error(result.error || 'Request failed. Please retry.'); }
    return result;
  } catch (error) { if (error.name === 'AbortError') throw new Error('The request was interrupted or timed out. Please retry.'); if (error instanceof TypeError) throw new Error('Could not reach the server. Check your connection and retry.'); throw error; }
  finally { clearTimeout(timer); controllers.delete(controller); }
}
function setBusy(value) {
  busy = value;
  for (const button of $$('[data-action], #chat-form button, #complete-chat, .flow-form button')) button.disabled = value || !!conversation?.completed;
  $('#message').disabled = value || !!conversation?.completed;
  $('#messages').setAttribute('aria-busy', String(value));
  $('#chat-status').textContent = value ? 'Working on your request…' : conversation?.completed ? 'Conversation complete' : 'Ready when you are';
}
function showLogin(message = '', mode = 'login', syncHash = true) {
  epoch++; user = null; conversation = null; creating = null; busy = false; catalog = null; adminVersion++; libraryVersion++;
  for (const controller of controllers) controller.abort();
  for (const el of $$('[id$="-view"], #app-nav, #account-menu')) el.hidden = true;
  $('#login-view').hidden = false; $('#admin-nav').hidden = true; $('#public-nav').hidden = true;
  for (const selector of ['#messages', '#conversation-list', '#quote-list', '#unresolved-queue', '#knowledge-list', '#metrics', '#activity-chart', '#model-chart']) $(selector).replaceChildren();
  $('#profile-form').reset(); $('#knowledge-form').reset(); $('#admin-filters').reset(); libraryPage = quotePage = queuePage = knowledgePage = 1; $('#profile-recovery').hidden = true; $('#profile-recovery-code').textContent = '';
  $('#recovery-result').hidden = true; $('#recovery-code').textContent = ''; recoveryCode = ''; pendingUser = null;
  setAuthMode(mode); notify(message, !!message); if (syncHash) history.replaceState(null, '', `${location.pathname}#${mode === 'register' ? 'register' : 'login'}`); $('#login-title').focus();
}
function showWelcome(syncHash = true) {
  showLogin('', 'login', false);
  $('#login-view').hidden = true; $('#welcome-view').hidden = false; $('#public-nav').hidden = false;
  if (syncHash) history.replaceState(null, '', `${location.pathname}#welcome`);
  $('#welcome-title').focus({ preventScroll: true }); window.scrollTo(0, 0);
}
function routePublic() {
  if (user) return;
  const errors = {
    google_unavailable: 'Google sign-in is currently unavailable. You can use your username and password.',
    google_cancelled: 'Google sign-in was cancelled. Try again or use your username and password.',
    google_invalid: 'Your Google sign-in request expired or could not be verified. Please try again.',
    google_failed: 'Could not complete Google sign-in. Please try again.',
    google_email_unverified: 'Google could not confirm your email address. Try another Google account or sign in with your username.'
  };
  const params = new URLSearchParams(location.search);
  if (params.has('auth_error')) { const key = params.get('auth_error'); showLogin(Object.hasOwn(errors, key) ? errors[key] : 'Could not complete sign-in. Please try again.'); return; }
  if (location.hash === '#login' || location.hash === '#register') showLogin('', location.hash === '#register' ? 'register' : 'login');
  else showWelcome(false);
}
for (const button of $$('[data-auth-open]')) button.addEventListener('click', () => {
  const mode = button.dataset.authOpen; history.pushState(null, '', `${location.pathname}#${mode}`); showLogin('', mode);
});
$('#back-to-welcome').addEventListener('click', () => { history.pushState(null, '', `${location.pathname}#welcome`); showWelcome(false); });
window.addEventListener('hashchange', () => { if (['#login', '#register', '#welcome', ''].includes(location.hash)) routePublic(); });
window.addEventListener('popstate', () => routePublic());
function updateGoogleOption() {
  $('#google-option').hidden = authMode === 'reset' || !$('#recovery-result').hidden;
  $('#google-login').disabled = googleEnabled !== true;
  $('#google-status').textContent = googleConfigFailed ? 'Could not load Google sign-in. You can retry or use your username and password.' : googleEnabled === null ? 'Checking sign-in options…' : googleEnabled ? 'Use your Google account to sign in or create a Portside account.' : 'Google sign-in is currently unavailable. You can use your username and password.';
  $('#retry-google-config').hidden = !googleConfigFailed;
}
async function loadAuthOptions() {
  googleConfigFailed = false; googleEnabled = null; updateGoogleOption();
  try { const result = await api('/api/auth/config'); googleEnabled = result.googleEnabled === true; }
  catch { googleEnabled = false; googleConfigFailed = true; }
  updateGoogleOption();
}
$('#retry-google-config').addEventListener('click', loadAuthOptions);
$('#google-login').addEventListener('click', () => { if (!googleEnabled) return; $('#google-login').disabled = true; $('#google-status').textContent = 'Taking you to Google…'; location.assign('/api/auth/google'); });
window.addEventListener('pageshow', updateGoogleOption);
async function showApp(account) {
  user = account; epoch++; const token = epoch; activeView = 'importer'; conversation = null; creating = null;
  $('#login-view').hidden = true; $('#welcome-view').hidden = true; $('#public-nav').hidden = true; history.replaceState(null, '', location.pathname); $('#app-nav').hidden = false; $('#account-menu').hidden = false; $('#admin-nav').hidden = user.role !== 'admin';
  $('#account-name').textContent = user.name || user.username; notify(''); switchView('importer'); renderConversation();
  try { catalog = await api('/api/catalog'); if (token !== epoch) return; const count = Object.values(catalog.providers).filter(Boolean).length; $('#data-mode').textContent = count === 0 ? 'Demo data' : count === 4 ? 'Connected providers' : 'Mixed data sources'; }
  catch (error) { if (token === epoch) notify(`Could not load service settings. ${error.message}`, true); }
}
function switchView(view) {
  if (!user || (view === 'admin' && user.role !== 'admin')) return;
  activeView = view;
  for (const name of ['importer', 'library', 'admin', 'profile']) $(`#${name}-view`).hidden = name !== view;
  for (const button of $$('[data-view]')) { if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
  $(`#${view === 'importer' ? 'assistant' : view}-title`).focus();
  if (view === 'library') loadLibrary();
  if (view === 'admin') renderAdmin();
  if (view === 'profile') { const form = $('#profile-form'); form.reset(); form.elements.username.value = user.username; form.elements.name.value = user.name || user.username; $('#profile-feedback').textContent = ''; $('#profile-recovery').hidden = true; $('#profile-recovery-code').textContent = ''; const google = user.authProvider === 'google'; $('#profile-identity-label').textContent = google ? 'Email address' : 'Username'; form.elements.username.value = google ? user.email : user.username; $('#password-settings').hidden = google; for (const input of $$('#password-settings input')) input.disabled = google; $('#google-account-note').hidden = !google; if (google && user.email) $('#google-account-note').textContent = `You sign in with Google (${user.email}). Manage your password and account recovery in your Google account.`; }
}
for (const button of $$('[data-view]')) button.addEventListener('click', () => switchView(button.dataset.view));
function setAuthMode(mode) {
  authMode = mode; $('#login-form').reset(); $('#password').type = 'password'; $('#toggle-password').textContent = 'Show'; $('#toggle-password').setAttribute('aria-pressed', 'false'); $('#toggle-password').setAttribute('aria-label', 'Show password'); $('#login-error').hidden = true; $('#login-form').hidden = false; $('#recovery-result').hidden = true; $('#demo-hint').hidden = mode !== 'login';
  $('#name-field').hidden = mode !== 'register'; $('#recovery-field').hidden = mode !== 'reset';
  $('#login-form').elements.name.required = mode === 'register'; $('#login-form').elements.recoveryCode.required = mode === 'reset';
  $('#password-label').textContent = mode === 'reset' ? 'New password' : 'Password'; $('#password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#password').minLength = mode === 'login' ? 1 : 12; $('#password-hint').hidden = mode === 'login'; $('#auth-submit').textContent = mode === 'login' ? 'Sign in →' : mode === 'register' ? 'Create account' : 'Reset password';
  for (const button of $$('[data-auth]')) button.setAttribute('aria-pressed', String(button.dataset.auth === mode));
  updateGoogleOption();
}
for (const button of $$('[data-auth]')) button.addEventListener('click', () => { setAuthMode(button.dataset.auth); history.replaceState(null, '', `${location.pathname}#${button.dataset.auth === 'register' ? 'register' : 'login'}`); });
$('#toggle-password').addEventListener('click', () => { const show = $('#password').type === 'password'; $('#password').type = show ? 'text' : 'password'; $('#toggle-password').textContent = show ? 'Hide' : 'Show'; $('#toggle-password').setAttribute('aria-pressed', String(show)); $('#toggle-password').setAttribute('aria-label', show ? 'Hide password' : 'Show password'); });
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#auth-submit'), mode = authMode; button.disabled = true; $('#login-error').hidden = true;
  for (const item of $$('[data-auth]')) item.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(event.target)), result = await api(mode === 'login' ? '/api/login' : mode === 'register' ? '/api/register' : '/api/reset-password', data);
    event.target.reset();
    if (result.recoveryCode) { recoveryCode = result.recoveryCode; pendingUser = result.user || null; $('#recovery-code').textContent = recoveryCode; $('#login-form').hidden = true; $('#recovery-result').hidden = false; updateGoogleOption(); $('#recovery-result').scrollIntoView({ block: 'nearest' }); }
    else await showApp(result.user);
  } catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; }
  finally { button.disabled = false; for (const item of $$('[data-auth]')) item.disabled = false; }
});
function download(filename, content, type = 'text/plain') { const url = URL.createObjectURL(new Blob([content], { type })); const link = node('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('#download-recovery').addEventListener('click', () => download('portside-recovery.txt', `Portside private recovery code\nUsername: ${pendingUser?.username || 'your account'}\nCode: ${recoveryCode}\nKeep this private. Each password recovery replaces the previous code.`));
$('#continue-auth').addEventListener('click', () => { const account = pendingUser; recoveryCode = ''; pendingUser = null; $('#recovery-code').textContent = ''; if (account) showApp(account); else { setAuthMode('login'); notify('Password reset. Sign in using your new password.'); } });
$('#logout').addEventListener('click', async () => { $('#logout').disabled = true; try { await api('/api/logout', {}); showWelcome(); } catch (error) { notify(error.message, true); } finally { $('#logout').disabled = false; } });
$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button[type=submit]'), token = epoch; button.disabled = true;
  try { const data = Object.fromEntries(new FormData(event.target)); data.rotateRecovery = user.authProvider !== 'google' && event.target.elements.rotateRecovery.checked; const result = await api('/api/profile', data); if (token !== epoch) return; user = result.user; $('#account-name').textContent = user.name; event.target.elements.currentPassword.value = ''; event.target.elements.password.value = ''; event.target.elements.rotateRecovery.checked = false; feedback($('#profile-feedback'), 'Account updated.'); $('#profile-recovery').hidden = !result.recoveryCode; $('#profile-recovery-code').textContent = result.recoveryCode || ''; }
  catch (error) { if (token === epoch) feedback($('#profile-feedback'), error.message, true); }
  finally { button.disabled = false; }
});
$('#download-profile-recovery').addEventListener('click', () => download('portside-recovery.txt', `Portside private recovery code\nUsername: ${user.username}\nCode: ${$('#profile-recovery-code').textContent}\nKeep this private.`));
function bubble(content, role = 'assistant', at) { const el = node('article', `message ${role === 'user' ? 'user-message' : 'bot-message'}`); el.setAttribute('aria-label', role === 'user' ? 'You' : 'Portside'); if (content) el.append(node('p', '', content)); if (at) { const time = node('time', '', date(at)); time.dateTime = at; el.append(time); } $('#messages').append(el); return el; }
function appendBeforeTime(parent, child) { const time = parent.querySelector(':scope > time'); parent.insertBefore(child, time || null); }
function resultText(result) { return `${result.title}\nSource: ${result.source}\nGenerated: ${date(result.updatedAt)}\n${result.input ? Object.entries(result.input).map(([key, value]) => `${key}: ${value}`).join('\n') : ''}\n\n${result.rows.map(([label, value]) => `${label}: ${typeof value === 'number' ? money(value) : value}`).join('\n')}\n${result.total !== undefined ? `Total: ${money(result.total)}\n` : ''}\n${result.notice}`; }
function showResult(parent, result, message, conversationId) {
  appendBeforeTime(parent, node('span', 'demo-pill', result.source === 'demo' ? 'Illustrative demo data' : 'Connected provider'));
  if (result.rows.length) { const table = node('table', 'result-table'); const caption = node('caption', 'sr-only', result.title); table.append(caption); const tbody = node('tbody');
    for (const [label, value] of result.rows) { const row = node('tr'); const th = node('th', '', label); th.scope = 'row'; row.append(th, node('td', '', typeof value === 'number' ? money(value) : value)); tbody.append(row); }
    if (result.total !== undefined && message?.service !== 'advisor') { const row = node('tr', 'total'); const th = node('th', '', result.source === 'demo' ? 'Illustrative total' : 'Provider total'); th.scope = 'row'; row.append(th, node('td', '', money(result.total))); tbody.append(row); } table.append(tbody); appendBeforeTime(parent, table);
  }
  if (result.input?.model) appendBeforeTime(parent, node('p', 'caption', `${result.input.model} · ${result.input.registration} · ${result.input.engine} cc · ${result.input.fuel} · Reference value ${money(result.input.value)}`));
  if (result.milestones) { const list = node('ol', 'milestones'); for (const milestone of result.milestones) list.append(node('li', '', `${milestone.complete ? '✓ ' : 'Pending: '}${milestone.label}${milestone.date ? ` · ${milestone.date}` : ''}`)); appendBeforeTime(parent, list); }
  appendBeforeTime(parent, node('p', 'caption', result.notice)); appendBeforeTime(parent, node('p', 'caption', `${result.source === 'demo' ? 'Preview generated' : 'Retrieved'} ${date(result.updatedAt)}`));
  const actions = node('div', 'actions');
  if (message && ['quote', 'advisor'].includes(message.service)) { const save = node('button', 'secondary', 'Save estimate'); save.type = 'button'; actions.append(save); save.addEventListener('click', async () => { const token = epoch; save.disabled = true; try { await api('/api/quotes', { conversationId, messageId: message.id }); if (token === epoch) { save.textContent = 'Saved to library'; notify('Estimate saved to My library.'); } } catch (error) { if (token === epoch) { notify(error.message, true); save.disabled = false; } } }); }
  const exportButton = node('button', 'secondary', 'Download estimate'); exportButton.type = 'button'; if (['quote', 'advisor'].includes(message?.service) || result.total !== undefined) { exportButton.addEventListener('click', () => download('portside-estimate.txt', resultText(result))); actions.append(exportButton); }
  if (actions.children.length) appendBeforeTime(parent, actions);
}
function renderConversation() {
  const messages = $('#messages'); messages.replaceChildren(); $('#chat-feedback').hidden = true; $('#chat-feedback').classList.remove('error');
  if (!conversation?.messages.length) bubble('Karibu! 👋 Choose a service to explore landed costs, compare import timing, check vehicle history or track a shipment.\n\nYour conversation is saved to your account when you send a message or submit a service form. Each result identifies whether it uses demo or provider data.');
  else conversation.messages.forEach((message, index) => { const el = bubble(message.content, message.role, message.at); if (message.result) showResult(el, message.result, message, conversation.id); if (message.action && index === conversation.messages.length - 1 && !conversation.completed) appendBeforeTime(el, flowForm(message.action)); });
  $('#complete-chat').hidden = !conversation || !conversation.messages.length; $('#complete-chat').textContent = conversation?.completed ? 'Completed' : 'Mark complete';
  setBusy(false); messages.scrollTop = messages.scrollHeight;
}
async function ensureConversation(token) {
  if (conversation) return conversation;
  if (!creating) creating = api('/api/conversations', {}).then((result) => result.conversation);
  const pending = creating;
  try { const c = await pending; if (token !== epoch) return null; conversation = c; return c; }
  finally { if (creating === pending) creating = null; }
}
function resetChat() { epoch++; conversation = null; creating = null; notify(''); renderConversation(); $('#message').value = ''; $('#message').focus(); }
$('#clear-chat').addEventListener('click', resetChat);
$('#complete-chat').addEventListener('click', async () => { if (!conversation || busy || conversation.completed) return; const token = epoch; setBusy(true); try { const result = await api(`/api/conversations/${conversation.id}`, { completed: true }); if (token === epoch) { conversation = result.conversation; renderConversation(); notify('Conversation marked complete. You can reopen it from My library.'); } } catch (error) { if (token === epoch) notify(error.message, true); } finally { if (token === epoch) setBusy(false); } });
function field(form, labelText, name, options = {}) {
  const label = node('label', options.full ? 'full-width' : '', labelText), input = node(options.choices ? 'select' : 'input'); input.name = name;
  if (options.choices) for (const choice of options.choices) input.append(new Option(typeof choice === 'string' ? choice : choice.name, typeof choice === 'string' ? choice : choice.name));
  else { input.type = options.type || 'text'; for (const key of ['min', 'max', 'maxLength', 'step', 'placeholder', 'pattern']) if (options[key] !== undefined) input[key] = options[key]; }
  input.required = options.required !== false; if (options.value !== undefined) input.value = options.value;
  const error = node('span', 'field-error'); error.id = `error-${id()}`; error.hidden = true; input.setAttribute('aria-describedby', error.id); label.append(input); if (options.hint) label.append(node('span', 'hint', options.hint)); label.append(error); form.append(label);
  input.addEventListener('invalid', () => { error.textContent = input.validationMessage; error.hidden = false; input.setAttribute('aria-invalid', 'true'); });
  input.addEventListener('input', () => { input.setCustomValidity(''); error.hidden = true; input.removeAttribute('aria-invalid'); });
  return input;
}
function localMonth() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit' }).format(new Date()); }
function flowForm(action) {
  const form = node('form', 'flow-form'); form.dataset.service = action;
  const header = node('p', 'caption', catalog?.providers[action] ? 'This service uses a connected provider.' : 'This service uses illustrative demo data.'); form.append(header);
  if (['quote', 'advisor'].includes(action)) {
    const fields = node('div', 'fields'); form.append(fields);
    const choices = catalog?.models || [{ name: 'Toyota Harrier', value: 1850000 }, { name: 'Toyota Prado', value: 3200000 }, { name: 'Mazda CX-5', value: 1400000 }, { name: 'Nissan X-Trail', value: 1250000 }, { name: 'Other vehicle', value: null }];
    const model = field(fields, 'Vehicle model', 'modelChoice', { choices });
    const other = field(fields, 'Vehicle make and model', 'model', { maxLength: 80, required: false, placeholder: 'e.g. Honda Fit' }); other.parentElement.hidden = true; other.disabled = true;
    field(fields, 'First registration month', 'registration', { type: 'month', min: '1900-01', max: localMonth(), value: '2019-12' });
    const engine = field(fields, 'Engine capacity (cc)', 'engine', { type: 'number', min: 600, max: 10000, step: 1, value: 2000 });
    const fuel = field(fields, 'Fuel type', 'fuel', { choices: ['Petrol', 'Diesel', 'Hybrid', 'Electric'] });
    const value = field(fields, 'Reference vehicle value (Ksh)', 'value', { type: 'number', min: 100000, max: 100000000, step: 1, value: choices[0].value, hint: 'Value before the sample age adjustment. Replace the example with your own reference value.' });
    field(fields, 'Freight and insurance (Ksh)', 'freight', { type: 'number', min: 0, max: 10000000, step: 1, value: 120000 });
    field(fields, 'Port, clearing and local fees (Ksh)', 'fees', { type: 'number', min: 0, max: 10000000, step: 1, value: 80000 });
    model.addEventListener('change', () => { const custom = model.value === 'Other vehicle'; other.parentElement.hidden = !custom; other.disabled = !custom; other.required = custom; value.value = choices.find((item) => item.name === model.value)?.value || ''; });
    fuel.addEventListener('change', () => { const electric = fuel.value === 'Electric'; engine.min = electric ? 0 : 600; engine.max = electric ? 0 : 10000; engine.value = electric ? 0 : 2000; });
  } else {
    const vin = action === 'vin'; const input = field(form, vin ? 'Vehicle identification number' : 'BL / container number', 'reference', { maxLength: vin ? 17 : 40, pattern: vin ? '[A-HJ-NPR-Za-hj-npr-z0-9]{17}' : '[A-Za-z0-9][A-Za-z0-9-]{5,39}', placeholder: vin ? 'JTMBE31V006123456' : 'BL-KE-1024', hint: vin ? '17 characters, excluding I, O and Q. Sample: JTMBE31V006123456.' : 'Sample BL: BL-KE-1024 · Container: MSKU1234567.' }); input.autocapitalize = 'characters'; input.spellcheck = false;
  }
  const status = node('p', 'form-feedback'); status.setAttribute('role', 'status'); form.append(status);
  const submit = node('button', 'primary', action === 'quote' ? 'Calculate estimate' : action === 'advisor' ? 'Compare timing' : 'Look up record'); submit.type = 'submit'; form.append(submit);
  let requestId = id(); form.addEventListener('input', () => { requestId = id(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || !user || conversation?.completed) return; const token = epoch; const input = Object.fromEntries(new FormData(form)); if (input.modelChoice) { if (input.modelChoice !== 'Other vehicle') input.model = input.modelChoice; delete input.modelChoice; }
    setBusy(true); feedback(status, 'Looking up your result…');
    try { const c = await ensureConversation(token); if (!c || token !== epoch) return; const result = await api(`/api/services/${action}`, { conversationId: c.id, input, requestId }); if (token !== epoch) return; conversation = result.conversation; renderConversation(); }
    catch (error) { if (token === epoch) feedback(status, `${error.message} You can retry using the same form.`, true); }
    finally { if (token === epoch) setBusy(false); }
  }); return form;
}
function startFlow(action) {
  if (!user || busy) return;
  if (conversation?.completed) resetChat();
  const existing = $('#messages .flow-form'); if (existing && existing.dataset.service === action) { existing.querySelector('input,select')?.focus(); existing.scrollIntoView({ block: 'nearest' }); return; }
  for (const form of $$('#messages .flow-form')) form.remove();
  const title = { quote: 'Explore a landed-cost estimate', advisor: 'Compare import timing', vin: 'Check vehicle history', tracking: 'Track a shipment' }[action];
  const el = bubble(title); el.append(flowForm(action)); el.querySelector('input,select')?.focus(); el.scrollIntoView({ block: 'nearest' });
}
for (const button of $$('[data-action]')) button.addEventListener('click', () => startFlow(button.dataset.action));
let chatRequest = { text: '', id: '' };
$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const input = $('#message'), message = input.value.trim(); if (!message || busy || !user || conversation?.completed) return;
  if (chatRequest.text !== message) chatRequest = { text: message, id: id() };
  const token = epoch; setBusy(true); const status = $('#chat-feedback'); status.hidden = false; status.textContent = 'Sending your message…';
  try { const c = await ensureConversation(token); if (!c || token !== epoch) return; const result = await api('/api/chat', { conversationId: c.id, message, requestId: chatRequest.id }); if (token !== epoch) return; conversation = result.conversation; input.value = ''; chatRequest = { text: '', id: '' }; renderConversation(); }
  catch (error) { if (token === epoch) { status.textContent = `${error.message} Your message is still in the input. Press Send to retry.`; status.classList.add('error'); } }
  finally { if (token === epoch) { setBusy(false); input.focus(); } }
});
async function confirmDelete(message) { const dialog = $('#confirm-dialog'); $('#confirm-message').textContent = message; dialog.returnValue = 'cancel'; dialog.showModal(); return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true })); }
function pager(container, data, callback) { container.replaceChildren(); if (data.pages <= 1) return; const previous = node('button', 'secondary', 'Previous'), next = node('button', 'secondary', 'Next'); previous.type = next.type = 'button'; previous.disabled = data.page <= 1; next.disabled = data.page >= data.pages; previous.addEventListener('click', () => callback(data.page - 1)); next.addEventListener('click', () => callback(data.page + 1)); container.append(previous, node('span', '', `${data.page} / ${data.pages}`), next); }
async function loadLibrary() {
  if (!user) return;
  const version = ++libraryVersion, token = epoch; $('#library-feedback').replaceChildren(node('p', 'loading', 'Loading your library…')); $('#conversation-list').replaceChildren(); $('#quote-list').replaceChildren(); $('#conversation-pagination').replaceChildren(); $('#quote-pagination').replaceChildren();
  try {
    const [chats, quotes] = await Promise.all([api(`/api/conversations?page=${libraryPage}`), api(`/api/quotes?page=${quotePage}`)]); if (version !== libraryVersion || token !== epoch) return;
    libraryPage = chats.page; quotePage = quotes.page; $('#library-feedback').replaceChildren();
    if (!chats.items.length) $('#conversation-list').append(node('p', 'empty', 'No conversations yet. Send a message or submit a service form to start one.'));
    for (const chat of chats.items) {
      const item = node('article', 'list-item'); item.append(node('h3', '', chat.title), node('p', 'hint', `${date(chat.updatedAt)} · ${chat.messageCount} messages · ${chat.completed ? 'Complete' : 'In progress'}`)); const actions = node('div', 'actions');
      const open = node('button', 'primary', 'Open'), rename = node('button', 'secondary', 'Rename'), remove = node('button', 'text-button', 'Delete'); actions.append(open, rename, remove); item.append(actions);
      open.addEventListener('click', async () => { open.disabled = true; const t = epoch; try { const result = await api(`/api/conversations/${chat.id}`); if (t !== epoch) return; epoch++; creating = null; conversation = result.conversation; switchView('importer'); renderConversation(); } catch (error) { notify(error.message, true); } finally { open.disabled = false; } });
      rename.addEventListener('click', () => { if (item.querySelector('form')) return; const form = node('form', 'stack-form'); const input = field(form, 'Conversation title', 'title', { maxLength: 70, value: chat.title }); const save = node('button', 'secondary', 'Save title'); save.type = 'submit'; form.append(save); item.append(form); input.focus(); form.addEventListener('submit', async (event) => { event.preventDefault(); save.disabled = true; try { await api(`/api/conversations/${chat.id}`, { title: input.value }); if (conversation?.id === chat.id) conversation.title = input.value; loadLibrary(); } catch (error) { notify(error.message, true); save.disabled = false; } }); });
      remove.addEventListener('click', async () => { if (!await confirmDelete('Delete this conversation? Saved estimates will remain in your library.')) return; remove.disabled = true; try { await api(`/api/conversations/${chat.id}`, undefined, 'DELETE'); if (conversation?.id === chat.id) { epoch++; conversation = null; creating = null; renderConversation(); } loadLibrary(); } catch (error) { notify(error.message, true); remove.disabled = false; } }); $('#conversation-list').append(item);
    }
    if (!quotes.items.length) $('#quote-list').append(node('p', 'empty', 'No saved estimates. Calculate an estimate, then select “Save estimate”.'));
    for (const quote of quotes.items) { const item = node('article', 'list-item'); item.append(node('h3', '', quote.result.title), node('p', 'hint', `Saved ${date(quote.savedAt)}`)); const details = node('details'); details.append(node('summary', '', 'View breakdown')); showResult(details, quote.result, null, null); item.append(details); const remove = node('button', 'text-button', 'Remove saved estimate'); item.append(remove); remove.addEventListener('click', async () => { if (!await confirmDelete('Remove this estimate from your library?')) return; remove.disabled = true; try { await api(`/api/quotes/${quote.id}`, undefined, 'DELETE'); loadLibrary(); } catch (error) { notify(error.message, true); remove.disabled = false; } }); $('#quote-list').append(item); }
    pager($('#conversation-pagination'), chats, (page) => { libraryPage = page; loadLibrary(); }); pager($('#quote-pagination'), quotes, (page) => { quotePage = page; loadLibrary(); });
  } catch (error) { if (version !== libraryVersion || token !== epoch) return; $('#library-feedback').replaceChildren(node('p', 'error', error.message)); const retry = node('button', 'secondary', 'Retry'); retry.addEventListener('click', loadLibrary); $('#library-feedback').append(retry); }
}
$('#refresh-library').addEventListener('click', loadLibrary);
function adminParams() { const params = new URLSearchParams(new FormData($('#admin-filters'))); params.set('queuePage', queuePage); params.set('knowledgePage', knowledgePage); return params; }
function metric(label, value, caption) { const card = node('div', 'metric'); card.append(node('small', '', label), node('strong', '', String(value)), node('p', '', caption)); return card; }
async function renderAdmin() {
  if (user?.role !== 'admin') return; const version = ++adminVersion, token = epoch;
  $('#admin-content').hidden = true; $('#admin-feedback').replaceChildren(node('p', 'loading', 'Loading dashboard…')); $('#admin-updated').textContent = '';
  try {
    const data = await api(`/api/admin?${adminParams()}`); if (version !== adminVersion || token !== epoch || user?.role !== 'admin') return;
    $('#admin-feedback').replaceChildren(); $('#admin-content').hidden = false; $('#admin-updated').textContent = `Updated ${date(data.updatedAt)}`;
    $('#metrics').replaceChildren(metric('Total queries', data.metrics.total, 'Messages and service submissions'), metric('Estimate requests', data.metrics.quotes, 'Landed-cost requests'), metric('Unanswered questions', data.metrics.unresolved, 'All questions awaiting an answer'), metric('Completion rate', data.metrics.completionRate === null ? '—' : `${data.metrics.completionRate}%`, `${data.metrics.completed} of ${data.metrics.conversations} active chats marked complete`));
    const chart = $('#activity-chart'); chart.replaceChildren(); const labels = { quote: 'Quotes', advisor: 'Timing', vin: 'VIN', tracking: 'Tracking', unresolved: 'Unknown' }, max = Math.max(1, ...Object.values(data.counts));
    for (const [key, label] of Object.entries(labels)) { const row = node('div', 'chart-row'), track = node('div', 'chart-track'), fill = node('div', 'chart-fill'); fill.style.width = `${data.counts[key] / max * 100}%`; fill.setAttribute('aria-hidden', 'true'); track.append(fill); row.append(node('span', '', label), track, node('strong', '', data.counts[key])); chart.append(row); }
    const modelChart = $('#model-chart'); modelChart.replaceChildren(); const entries = Object.entries(data.models).sort((a, b) => b[1] - a[1]);
    if (!entries.length) modelChart.append(node('p', 'empty', 'No vehicle estimates in this date range.'));
    for (const [model, count] of entries) { const row = node('div', 'model-row'), label = node('div'), track = node('div', 'model-track'), fill = node('div', 'model-fill'); label.append(node('span', '', model), node('strong', '', count)); fill.style.width = `${count / entries[0][1] * 100}%`; fill.setAttribute('aria-hidden', 'true'); track.append(fill); row.append(label, track); modelChart.append(row); }
    $('#queue-count').textContent = `${data.queue.total} matching`; const queue = $('#unresolved-queue'); queue.replaceChildren();
    if (!data.queue.items.length) queue.append(node('p', 'empty', 'No unanswered questions match these filters.'));
    for (const question of data.queue.items) {
      const wrapper = node('article', 'queue-item'); wrapper.append(node('h3', '', question.question), node('p', 'hint', question.at ? date(question.at) : ''));
      const form = node('form', 'stack-form'), label = node('label', '', 'Answer'), answer = node('textarea'); answer.name = 'answer'; answer.required = true; answer.maxLength = 2000; answer.rows = 3; label.append(answer); const status = node('p', 'form-feedback'); status.setAttribute('role', 'status'); const actions = node('div', 'actions'), save = node('button', 'primary', 'Save answer'), dismiss = node('button', 'text-button', 'Dismiss question'); save.type = 'submit'; dismiss.type = 'button'; actions.append(save, dismiss); form.append(label, status, actions); wrapper.append(form); queue.append(wrapper);
      form.addEventListener('submit', async (event) => { event.preventDefault(); save.disabled = true; try { await api('/api/answers', { id: question.id, answer: answer.value.trim() }); renderAdmin(); } catch (error) { feedback(status, error.message, true); save.disabled = false; } });
      dismiss.addEventListener('click', async () => { if (!await confirmDelete('Dismiss this unanswered question?')) return; dismiss.disabled = true; try { await api(`/api/admin/questions/${question.id}`, undefined, 'DELETE'); renderAdmin(); } catch (error) { feedback(status, error.message, true); dismiss.disabled = false; } });
    }
    const knowledge = $('#knowledge-list'); knowledge.replaceChildren();
    if (!data.knowledgePage.items.length) knowledge.append(node('p', 'empty', 'No saved answers match your search.'));
    for (const item of data.knowledgePage.items) {
      const wrapper = node('article', 'knowledge-item'); wrapper.append(node('h3', '', item.question), node('p', '', item.answer)); const details = node('details'); details.append(node('summary', '', 'Edit answer'));
      const form = node('form', 'stack-form'); field(form, 'Question', 'question', { maxLength: 1000, value: item.question }); const label = node('label', '', 'Answer'), answer = node('textarea'); answer.value = item.answer; answer.required = true; answer.maxLength = 2000; answer.rows = 3; label.append(answer); const status = node('p', 'form-feedback'); status.setAttribute('role', 'status'); const save = node('button', 'primary', 'Save changes'); save.type = 'submit'; form.append(label, status, save); details.append(form); wrapper.append(details); const remove = node('button', 'text-button', 'Delete answer'); wrapper.append(remove); knowledge.append(wrapper);
      form.addEventListener('submit', async (event) => { event.preventDefault(); save.disabled = true; try { await api('/api/admin/knowledge', { id: item.id, question: form.elements.question.value, answer: answer.value }); renderAdmin(); } catch (error) { feedback(status, error.message, true); save.disabled = false; } });
      remove.addEventListener('click', async () => { if (!await confirmDelete('Delete this saved answer? The assistant will no longer use it.')) return; remove.disabled = true; try { await api(`/api/admin/knowledge/${item.id}`, undefined, 'DELETE'); renderAdmin(); } catch (error) { notify(error.message, true); remove.disabled = false; } });
    }
    pager($('#queue-pagination'), data.queue, (page) => { queuePage = page; renderAdmin(); }); pager($('#knowledge-pagination'), data.knowledgePage, (page) => { knowledgePage = page; renderAdmin(); });
  } catch (error) { if (version !== adminVersion || token !== epoch) return; $('#admin-content').hidden = true; $('#admin-feedback').replaceChildren(node('p', 'error', error.message)); const retry = node('button', 'secondary', 'Retry'); retry.addEventListener('click', renderAdmin); $('#admin-feedback').append(retry); }
}
$('#admin-filters').addEventListener('submit', (event) => { event.preventDefault(); const { from, to } = event.target.elements; to.setCustomValidity(from.value && to.value && from.value > to.value ? 'End date must be on or after start date.' : ''); if (!event.target.reportValidity()) return; queuePage = knowledgePage = 1; renderAdmin(); });
$('#admin-filters').addEventListener('input', () => $('#admin-filters').elements.to.setCustomValidity(''));
$('#reset-filters').addEventListener('click', () => { $('#admin-filters').reset(); $('#admin-filters').elements.to.setCustomValidity(''); queuePage = knowledgePage = 1; renderAdmin(); });
$('#refresh-admin').addEventListener('click', renderAdmin);
$('#knowledge-form').addEventListener('submit', async (event) => { event.preventDefault(); const button = event.target.querySelector('button'), status = event.target.querySelector('.form-feedback'); button.disabled = true; try { await api('/api/admin/knowledge', Object.fromEntries(new FormData(event.target))); event.target.reset(); status.textContent = ''; $('#add-knowledge').open = false; renderAdmin(); } catch (error) { feedback(status, error.message, true); } finally { button.disabled = false; } });
window.addEventListener('offline', () => notify('You are offline. Saved data will be available when you reconnect.', true));
window.addEventListener('online', () => notify('Connection restored. Retry any interrupted request.'));
routePublic();
const startupEpoch = epoch;
api('/api/session').then(({ user: account }) => { if (epoch === startupEpoch) showApp(account); }).catch((error) => { if (epoch === startupEpoch && !/session|sign in/i.test(error.message)) notify(error.message, true); });
loadAuthOptions();
