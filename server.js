const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getReply } = require('./chatbot');

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

const server = http.createServer((request, response) => {
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
