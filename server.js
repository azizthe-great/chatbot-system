const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const auth = require('./auth');
const googleAuth = require('./google-auth');
const { state, save } = require('./store');
const { models, currentMonth, runService } = require('./services');
const { getReply } = require('./chatbot');
const normalize = (text) => text.toLowerCase().replace(/[?!.,]/g, '').replace(/\s+/g, ' ').trim();
const now = () => new Date().toISOString();
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function text(value, max = 1000) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`Enter text of 1–${max} characters.`); return value.trim(); }
function send(response, status, payload) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(payload)); }
async function readJson(request) {
  let body = '';
  for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 32000) fail('Request too large.', 413); }
  try { const value = JSON.parse(body || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a JSON object.'); return value; } catch { fail('Invalid JSON request.'); }
}
function cookie(response, user) {
  const previous = response.getHeader('Set-Cookie');
  response.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), `portside_session=${auth.login(user)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`]);
}
function owned(id, user) { const item = state.conversations.find((c) => c.id === id && c.username === user.username); if (!item) fail('Conversation not found.', 404); return item; }
function record(user, intent, message, conversationId) {
  state.queries.push({ intent, message, conversationId, username: user.username, at: now() });
  if (intent === 'unresolved' && !state.unresolved.some((q) => normalize(q.question) === normalize(message))) state.unresolved.push({ id: randomUUID(), question: message, at: now() });
}
function addMessage(conversation, role, content, extra = {}) { const item = { id: randomUUID(), role, content, at: now(), ...extra }; conversation.messages.push(item); conversation.updatedAt = item.at; if (role === 'user' && conversation.title === 'New conversation') conversation.title = content.slice(0, 70); return item; }
function paginate(items, params, key = 'page') { const pageSize = 10, pages = Math.max(1, Math.ceil(items.length / pageSize)), page = Math.min(pages, Math.max(1, Number.parseInt(params.get(key), 10) || 1)); return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pages, total: items.length }; }
const attempts = new Map();
function limit(request) {
  const key = request.socket.remoteAddress, time = Date.now(); let bucket = attempts.get(key);
  if (!bucket || bucket.until < time) { bucket = { count: 0, until: time + 60000 }; attempts.set(key, bucket); }
  if (++bucket.count > 20) fail('Too many account attempts. Try again in a minute.', 429);
  if (attempts.size > 10000) for (const [id, value] of attempts) if (value.until < time) attempts.delete(id);
}
const inflight = new Map();
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url = new URL(request.url, 'http://localhost'), route = url.pathname, method = request.method;
    if (!route.startsWith('/api/')) {
      if (method !== 'GET') fail('Not found.', 404);
      const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
      if (!files[route]) fail('Not found.', 404);
      const file = files[route]; response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' });
      response.end(fs.readFileSync(path.join(__dirname, 'public', file))); return;
    }
    if (!['GET', 'POST', 'DELETE'].includes(method)) fail('Method not allowed.', 405);
    if (method !== 'GET' && request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) fail('Cross-origin request denied.', 403);
    if (method === 'GET' && route === '/api/auth/config') { send(response, 200, { googleEnabled: googleAuth.enabled() }); return; }
    if (method === 'GET' && route === '/api/auth/google') {
      try { limit(request); } catch (error) { if (error.status !== 429) throw error; googleAuth.redirect(response, 'google_unavailable'); return; }
      googleAuth.start(request, response); return;
    }
    if (method === 'GET' && route === '/api/auth/google/callback') {
      const googleUser = await googleAuth.callback(request, response, url.searchParams);
      if (googleUser) { auth.logout(request); cookie(response, googleUser); googleAuth.redirect(response); }
      return;
    }
    const data = method === 'POST' ? await readJson(request) : {};
    if (method === 'POST' && ['/api/login', '/api/register', '/api/reset-password'].includes(route)) {
      limit(request);
      if (route === '/api/login') { const user = auth.authenticate(data.username, data.password); if (!user) fail('Incorrect username or password.', 401); cookie(response, user); send(response, 200, { user }); return; }
      if (route === '/api/register') { const result = auth.register(data); cookie(response, result.user); send(response, 201, result); return; }
      send(response, 200, auth.reset(data)); return;
    }
    if (method === 'POST' && route === '/api/logout') { auth.logout(request); response.setHeader('Set-Cookie', 'portside_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); send(response, 200, { ok: true }); return; }
    const user = auth.currentUser(request); if (!user) fail('Your session has expired. Please sign in again.', 401);
    let result;
    if (method === 'GET' && route === '/api/session') result = { user };
    else if (method === 'POST' && route === '/api/profile') { result = auth.update(user, data); if (data.password) cookie(response, result.user); }
    else if (method === 'GET' && route === '/api/catalog') result = { models, currentMonth: currentMonth(), providers: Object.fromEntries(['quote', 'advisor', 'vin', 'tracking'].map((key) => [key, !!process.env[`PORTSIDE_${key.toUpperCase()}_URL`]])) };
    else if (method === 'GET' && route === '/api/conversations') result = paginate(state.conversations.filter((c) => c.username === user.username).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ messages, ...c }) => ({ ...c, messageCount: messages.length })), url.searchParams);
    else if (method === 'POST' && route === '/api/conversations') { const c = { id: randomUUID(), username: user.username, title: 'New conversation', createdAt: now(), updatedAt: now(), completed: false, messages: [] }; state.conversations.push(c); result = { conversation: c }; }
    else if (/^\/api\/conversations\/[^/]+$/.test(route)) {
      const c = owned(route.split('/').pop(), user);
      if (method === 'GET') result = { conversation: c };
      else if (method === 'DELETE') { state.conversations = state.conversations.filter((item) => item.id !== c.id); result = { ok: true }; }
      else if (method === 'POST') { if (data.title !== undefined) c.title = text(data.title, 70); if (typeof data.completed === 'boolean') c.completed = data.completed; c.updatedAt = now(); result = { conversation: c }; }
    }
    else if (method === 'POST' && (route === '/api/chat' || /^\/api\/services\/(quote|advisor|vin|tracking)$/.test(route))) {
      if (!data.conversationId && route === '/api/chat') { result = { reply: getReply(text(data.message)) }; }
      else {
        const c = owned(data.conversationId, user);
        if (c.completed) fail('This conversation is complete. Start a new chat to continue.');
        const requestId = text(data.requestId, 100), key = `${c.id}:${requestId}`;
        const existing = c.messages.find((m) => m.requestId === requestId && m.role === 'assistant');
        if (existing) result = { conversation: c, reply: existing };
        else if (inflight.has(key)) result = await inflight.get(key);
        else {
          const task = (async () => {
            let reply, intent, message;
            if (route === '/api/chat') {
              message = text(data.message); const normalized = normalize(message), known = state.knowledge.find((q) => normalize(q.question) === normalized);
              if (known) { intent = 'knowledge'; reply = { content: known.answer }; }
              else {
                intent = /\b(track|tracking|shipment|container|bl)\b/.test(normalized) ? 'tracking' : /\b(vin|history|accident|odometer|auction)\b/.test(normalized) ? 'vin' : /\b(when|timing|wait|depreciation|advisor)\b/.test(normalized) ? 'advisor' : /\b(quote|cost|duty|tax|price)\b/.test(normalized) ? 'quote' : /\b(hello|hi|hey|help|start)\b/.test(normalized) ? 'help' : 'unresolved';
                reply = { content: intent === 'unresolved' ? 'Your question has been saved for admin review. An answer will be available when an admin adds it to the knowledge base.' : intent === 'help' ? 'Karibu! Choose a landed-cost estimate, timing comparison, vehicle history check or shipment tracking.' : 'Complete the service form below to continue.', ...(['quote', 'advisor', 'vin', 'tracking'].includes(intent) ? { action: intent } : {}) };
              }
            } else {
              intent = route.split('/').pop(); const service = await runService(intent, data.input || {});
              owned(c.id, user); if (c.completed) fail('Conversation is complete.');
              message = service.input.model ? `${service.input.model} · ${service.input.registration} · ${service.input.engine} cc · ${service.input.fuel}` : service.input.reference;
              reply = { content: service.title, result: service, service: intent };
              if (service.input.model) state.models[service.input.model] = (state.models[service.input.model] || 0) + 1;
            }
            addMessage(c, 'user', message, { requestId }); record(user, intent, message, c.id);
            const assistant = addMessage(c, 'assistant', reply.content, { ...reply, requestId }); save();
            return { conversation: c, reply: assistant };
          })();
          inflight.set(key, task);
          try { result = await task; } finally { inflight.delete(key); }
        }
      }
    }
    else if (method === 'GET' && route === '/api/quotes') result = paginate(state.quotes.filter((q) => q.username === user.username).sort((a, b) => b.savedAt.localeCompare(a.savedAt)), url.searchParams);
    else if (method === 'POST' && route === '/api/quotes') {
      const c = owned(data.conversationId, user), message = c.messages.find((m) => m.id === data.messageId && ['quote', 'advisor'].includes(m.service) && m.result);
      if (!message) fail('Estimate not found.', 404);
      let quote = state.quotes.find((q) => q.username === user.username && q.messageId === message.id);
      if (!quote) { quote = { id: randomUUID(), username: user.username, messageId: message.id, result: message.result, savedAt: now() }; state.quotes.push(quote); }
      result = { quote };
    }
    else if (method === 'DELETE' && /^\/api\/quotes\/[^/]+$/.test(route)) { const id = route.split('/').pop(); if (!state.quotes.some((q) => q.id === id && q.username === user.username)) fail('Saved estimate not found.', 404); state.quotes = state.quotes.filter((q) => !(q.id === id && q.username === user.username)); result = { ok: true }; }
    else if (method === 'GET' && route === '/api/knowledge') result = { knowledge: state.knowledge };
    else if (method === 'POST' && route === '/api/activity') {
      if (data.model) { if (!models.some((m) => m.name === data.model)) fail('Invalid model.'); state.models[data.model] = (state.models[data.model] || 0) + 1; }
      else { if (!['quote', 'advisor', 'vin', 'tracking', 'help', 'knowledge', 'unresolved'].includes(data.intent)) fail('Invalid intent.'); record(user, data.intent, text(data.message)); }
      result = { ok: true };
    }
    else if (route.startsWith('/api/admin') || route === '/api/answers') {
      if (user.role !== 'admin') fail('Admin access required.', 403);
      if (method === 'GET' && route === '/api/admin') {
        const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '', search = (url.searchParams.get('search') || '').toLowerCase();
        if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) || (from && to && from > to)) fail('Choose a valid date range.');
        const inRange = (date) => { const day = date ? new Date(new Date(date).getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10) : ''; return (!from || day >= from) && (!to || day <= to); };
        const queries = state.queries.filter((q) => inRange(q.at)), conversations = state.conversations.filter((c) => inRange(c.createdAt));
        const counts = Object.fromEntries(['quote', 'advisor', 'vin', 'tracking', 'unresolved', 'help', 'knowledge'].map((intent) => [intent, queries.filter((q) => q.intent === intent).length]));
        const active = conversations.filter((c) => c.messages.length), completed = active.filter((c) => c.completed).length;
        const modelCounts = {}; for (const c of state.conversations) for (const m of c.messages) if (m.result?.input.model && inRange(m.at)) modelCounts[m.result.input.model] = (modelCounts[m.result.input.model] || 0) + 1;
        const queue = state.unresolved.filter((q) => q.question.toLowerCase().includes(search) && inRange(q.at));
        const knowledge = state.knowledge.filter((q) => `${q.question} ${q.answer}`.toLowerCase().includes(search));
        const queuePage = paginate(queue, url.searchParams, 'queuePage'), knowledgePage = paginate(knowledge, url.searchParams, 'knowledgePage');
        result = { counts, metrics: { total: queries.length, quotes: counts.quote, unresolved: state.unresolved.length, conversations: active.length, completed, completionRate: active.length ? Math.round(completed / active.length * 100) : null }, queue: queuePage, knowledgePage, models: modelCounts, updatedAt: now(), unresolved: queuePage.items, knowledge: knowledgePage.items, queries: queries.slice(-100) };
      }
      else if (method === 'POST' && route === '/api/answers') {
        const q = state.unresolved.find((item) => item.id === data.id); if (!q) fail('Question no longer available. Refresh the dashboard.', 409);
        const answer = text(data.answer, 2000);
        const existing = state.knowledge.find((item) => normalize(item.question) === normalize(q.question));
        if (existing) { existing.answer = answer; existing.updatedAt = now(); }
        else state.knowledge.push({ id: randomUUID(), question: q.question, answer, updatedAt: now() });
        state.unresolved = state.unresolved.filter((item) => item.id !== q.id); result = { ok: true };
      }
      else if (method === 'POST' && route === '/api/admin/knowledge') {
        const question = text(data.question), answer = text(data.answer, 2000);
        let item = data.id ? state.knowledge.find((q) => q.id === data.id) : null;
        if (data.id && !item) fail('Answer not found.', 404);
        if (state.knowledge.some((q) => q.id !== data.id && normalize(q.question) === normalize(question))) fail('An answer already exists for that question.', 409);
        if (!item) { item = { id: randomUUID() }; state.knowledge.push(item); }
        Object.assign(item, { question, answer, updatedAt: now() }); result = { item };
      }
      else if (method === 'DELETE' && /^\/api\/admin\/knowledge\/[^/]+$/.test(route)) { const id = route.split('/').pop(); if (!state.knowledge.some((q) => q.id === id)) fail('Answer not found.', 404); state.knowledge = state.knowledge.filter((q) => q.id !== id); result = { ok: true }; }
      else if (method === 'DELETE' && /^\/api\/admin\/questions\/[^/]+$/.test(route)) { const id = route.split('/').pop(); if (!state.unresolved.some((q) => q.id === id)) fail('Question not found.', 404); state.unresolved = state.unresolved.filter((q) => q.id !== id); result = { ok: true }; }
    }
    if (result === undefined) fail('Not found.', 404);
    if (method !== 'GET') save(); send(response, 200, result);
  } catch (error) { if (!response.headersSent) send(response, error.status || 400, { error: error.status === 500 ? 'Unable to complete the request.' : error.message || 'Request failed.' }); }
});
if (require.main === module) server.listen(Number(process.env.PORT) || 3000, () => console.log(`Portside running at http://localhost:${Number(process.env.PORT) || 3000}`));
module.exports = { server };
