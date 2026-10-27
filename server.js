'use strict';
const path = require('node:path');
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const rateLimit = require('@fastify/rate-limit');
const fastifyStatic = require('@fastify/static');
const config = require('./src/config');
const { getPool } = require('./src/database/pool');
const auth = require('./src/services/auth');
const google = require('./src/services/google-auth');
const { errorPayload } = require('./src/http');
const { registerAuthRoutes, SESSION_COOKIE } = require('./src/routes/auth');
const { registerRecordRoutes } = require('./src/routes/records');
const { registerAssistantRoutes } = require('./src/routes/assistant');
const { registerAdminRoutes } = require('./src/routes/admin');

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

function buildApp(options = {}) {
  const db = options.db || getPool();
  const settings = { ...config, ...options.config };
  const app = Fastify({
    logger: { level: settings.logLevel || 'info', redact: ['req.headers.cookie', 'req.body.password'] },
    trustProxy: settings.trustProxy,
    bodyLimit: 32 * 1024
  });
  app.decorateRequest('user', null);
  app.register(cookie);
  app.register(rateLimit, { global: true, max: settings.globalRateLimitMax ?? 200, timeWindow: '15 minutes' });
  app.register(fastifyStatic, { root: path.join(__dirname, 'public'), prefix: '/' });

  app.addHook('onRequest', async (request, reply) => {
    reply.headers(securityHeaders);
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin) {
      let sameHost = false;
      try { sameHost = new URL(request.headers.origin).host === request.headers.host; } catch { /* malformed origin */ }
      if (!sameHost) return reply.code(403).send(errorPayload('FORBIDDEN', 'Cross-origin request denied.'));
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.validation) return reply.code(400).send(errorPayload('VALIDATION_ERROR', 'Please check the submitted information.', error.validation.map((item) => ({ field: item.instancePath || item.params?.missingProperty, message: item.message }))));
    if (error.statusCode === 429) {
      // Google sign-in is a browser navigation, so it gets a page redirect rather than JSON.
      if (request.routeOptions?.url === '/api/auth/google') return reply.redirect(google.errorLocation('google_unavailable'));
      return reply.code(429).send(errorPayload('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
    }
    if (error.code === '23505') return reply.code(409).send(errorPayload('CONFLICT', 'A record with these details already exists.'));
    if (error.code === '23503') return reply.code(400).send(errorPayload('INVALID_REFERENCE', 'The related record is unavailable.'));
    if (['23514', '22007', '22008', '22P02'].includes(error.code)) return reply.code(400).send(errorPayload('INVALID_INPUT', 'Please check the submitted information.'));
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send(errorPayload(error.publicCode || 'REQUEST_ERROR', error.message));
    request.log.error({ errorCode: error.code || error.name, requestId: request.id }, 'Request failed');
    return reply.code(500).send(errorPayload('INTERNAL_ERROR', 'The request could not be completed.'));
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(errorPayload('NOT_FOUND', 'The requested endpoint was not found.')));

  async function requireUser(request, reply) {
    const user = await auth.findSession(db, request.cookies[SESSION_COOKIE]);
    if (!user) return reply.code(401).send(errorPayload('UNAUTHENTICATED', 'Your session has expired. Please sign in again.'));
    request.user = user;
  }
  async function requireAdmin(request, reply) {
    if (request.user?.role !== 'admin') return reply.code(403).send(errorPayload('FORBIDDEN', 'Administrator access is required.'));
  }
  async function requireCustomer(request, reply) {
    if (request.user?.role !== 'customer') return reply.code(403).send(errorPayload('FORBIDDEN', 'A customer account is required.'));
  }
  const context = { db, settings, requireUser, requireAdmin, requireCustomer };
  registerAuthRoutes(app, context);
  registerRecordRoutes(app, context);
  registerAssistantRoutes(app, context);
  registerAdminRoutes(app, context);

  app.get('/health', async (request, reply) => {
    try { await db.query('SELECT 1'); return { status: 'ok', database: 'ok' }; }
    catch { return reply.code(503).send({ status: 'unavailable', database: 'unavailable' }); }
  });
  return app;
}

if (require.main === module) {
  try {
    const app = buildApp();
    app.listen({ port: config.port, host: config.host }).then(() => {
      app.log.info(`Portside is running at http://${config.host}:${config.port}`);
    }).catch((error) => { app.log.error({ errorCode: error.code || error.name }, 'Server could not start'); process.exitCode = 1; });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildApp };
