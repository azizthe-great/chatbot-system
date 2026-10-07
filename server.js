const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getReply } = require('./chatbot');
const auth = require('./auth');
const demoState = { queries: [], unresolved: [], knowledge: [], models: {} };
const normalize = (text) => text.toLowerCase().replace(/[?!.,]/g, '').replace(/\s+/g, ' ').trim();

const root = __dirname;
const port = Number(process.env.PORT) || 3000;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function serveStatic(request, response) {
  const requestPath = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  const filePath = path.join(root, 'public', requestPath);

  if (!filePath.startsWith(path.join(root, 'public'))) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    const extension = path.extname(filePath);
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    }[extension] || 'application/octet-stream';

    response.writeHead(200, { 'Content-Type': contentType });
    response.end(content);
  });
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16000) throw new Error('Request too large.');
  }
  return JSON.parse(body || '{}');
}

const server = http.createServer(async (request, response) => {
  if (request.url.startsWith('/api/')) {
    const user = auth.currentUser(request);
    if (request.method === 'POST' && request.url === '/api/login') {
      try {
        const data = await readJson(request);
        const account = auth.authenticate(data.username, data.password);
        if (!account) { sendJson(response, 401, { error: 'Incorrect username or password.' }); return; }
        response.setHeader('Set-Cookie', `portside_session=${auth.login(account)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        sendJson(response, 200, { user: account });
      } catch { sendJson(response, 400, { error: 'Invalid login request.' }); }
      return;
    }
    if (request.method === 'POST' && request.url === '/api/logout') {
      auth.logout(request);
      response.setHeader('Set-Cookie', 'portside_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      sendJson(response, 200, { ok: true }); return;
    }
    if (!user) { sendJson(response, 401, { error: 'Please sign in.' }); return; }
    if (request.method === 'GET' && request.url === '/api/session') { sendJson(response, 200, { user }); return; }
    if (request.url === '/api/admin' || request.url === '/api/answers') {
      if (user.role !== 'admin') { sendJson(response, 403, { error: 'Admin access required.' }); return; }
    }
    if (request.method === 'GET' && request.url === '/api/admin') { sendJson(response, 200, demoState); return; }
    if (request.method === 'GET' && request.url === '/api/knowledge') { sendJson(response, 200, { knowledge: demoState.knowledge }); return; }
    if (request.method === 'POST' && request.url === '/api/activity') {
      try {
        const data = await readJson(request);
        if (data.model) {
          if (!['Toyota Harrier', 'Toyota Prado', 'Mazda CX-5', 'Nissan X-Trail'].includes(data.model)) throw new Error();
          demoState.models[data.model] = (demoState.models[data.model] || 0) + 1;
        } else {
          if (!['quote', 'advisor', 'vin', 'tracking', 'help', 'knowledge', 'unresolved'].includes(data.intent) || typeof data.message !== 'string' || !data.message.trim() || data.message.length > 1000) throw new Error();
          demoState.queries.push({ intent: data.intent, message: data.message, username: user.username, at: new Date().toISOString() });
          if (data.intent === 'unresolved' && !demoState.unresolved.some((q) => normalize(q.question) === normalize(data.message))) demoState.unresolved.push({ id: require('node:crypto').randomUUID(), question: data.message });
        }
        sendJson(response, 200, { ok: true });
      } catch { sendJson(response, 400, { error: 'Invalid activity request.' }); }
      return;
    }
    if (request.method === 'POST' && request.url === '/api/answers') {
      try {
        const data = await readJson(request); const question = demoState.unresolved.find((q) => q.id === data.id);
        if (!question || typeof data.answer !== 'string' || !data.answer.trim() || data.answer.length > 2000) throw new Error();
        demoState.knowledge.push({ question: question.question, answer: data.answer.trim() });
        demoState.unresolved = demoState.unresolved.filter((q) => q.id !== data.id);
        sendJson(response, 200, { ok: true });
      } catch { sendJson(response, 400, { error: 'Question unavailable or answer invalid.' }); }
      return;
    }
  }
  if (request.method === 'GET') {
    serveStatic(request, response);
    return;
  }

  if (request.method === 'POST' && request.url === '/api/chat') {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
    });

    request.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const message = String(data.message || '').trim();

        if (!message) {
          sendJson(response, 400, { error: 'Message is required.' });
          return;
        }

        sendJson(response, 200, { reply: getReply(message) });
      } catch {
        sendJson(response, 400, { error: 'Invalid JSON request.' });
      }
    });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Chatbot system is running at http://localhost:${port}`);
  });
}

module.exports = { server };
