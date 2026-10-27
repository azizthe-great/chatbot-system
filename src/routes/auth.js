'use strict';
const auth = require('../services/auth');
const google = require('../services/google-auth');
const { recordAudit } = require('../services/audit');
const { errorPayload } = require('../http');

const SESSION_COOKIE = 'portside_session';
const email = { type: 'string', format: 'email', maxLength: 254 };
const password = { type: 'string', minLength: 12, maxLength: 256 };
const bodySchema = (required, properties) => ({ body: { type: 'object', additionalProperties: false, required, properties } });

function registerAuthRoutes(app, { db, settings, requireUser }) {
  const cookieOptions = () => ({ httpOnly: true, sameSite: 'strict', secure: Boolean(settings.cookieSecure), path: '/' });
  const attempts = (max) => ({ rateLimit: { max: settings.authRateLimitMax ?? max, timeWindow: '15 minutes' } });
  async function startSession(reply, userId) {
    const session = await auth.createSession(db, userId, settings.sessionTtlHours);
    reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions(), expires: session.expiresAt });
  }
  const userSession = async (request) => auth.findSession(db, request.cookies[SESSION_COOKIE]);

  const loginHandler = async (request, reply) => {
    const user = await auth.authenticate(db, request.body.email, request.body.password);
    if (!user) return reply.code(401).send(errorPayload('INVALID_CREDENTIALS', 'Email or password is incorrect.'));
    await startSession(reply, user.id);
    await recordAudit(db, { actorId: user.id, action: 'auth.login', recordType: 'session' });
    return { user: auth.publicUser(user) };
  };
  app.post('/api/auth/login', { schema: bodySchema(['email', 'password'], { email, password: { type: 'string', minLength: 1, maxLength: 256 } }), config: attempts(5) }, loginHandler);
  // Compatibility endpoint accepts the old username field but never exposes the old demo accounts.
  app.post('/api/login', { schema: bodySchema(['username', 'password'], { username: { type: 'string', maxLength: 254 }, password: { type: 'string', minLength: 1, maxLength: 256 } }), config: attempts(5) }, async (request, reply) => loginHandler({ body: { email: request.body.username, password: request.body.password } }, reply));

  app.post('/api/auth/register', { schema: bodySchema(['name', 'email', 'password'], { name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' }, email, password }), config: attempts(3) }, async (request, reply) => {
    const { user, recoveryCode } = await auth.registerCustomer(db, request.body);
    await startSession(reply, user.id);
    await recordAudit(db, { actorId: user.id, action: 'auth.register', recordType: 'user', recordId: user.id });
    return reply.code(201).send({ user: auth.publicUser(user), recoveryCode });
  });
  app.post('/api/auth/reset-password', { schema: bodySchema(['email', 'recoveryCode', 'password'], { email, recoveryCode: { type: 'string', minLength: 1, maxLength: 100 }, password }), config: attempts(5) }, async (request) => auth.resetPassword(db, request.body));

  const logoutHandler = async (request, reply) => {
    const user = await userSession(request);
    await auth.deleteSession(db, request.cookies[SESSION_COOKIE]);
    if (user) await recordAudit(db, { actorId: user.id, action: 'auth.logout', recordType: 'session' });
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return { ok: true };
  };
  app.post('/api/auth/logout', logoutHandler);
  app.post('/api/logout', logoutHandler);
  const meHandler = async (request, reply) => {
    const user = await userSession(request);
    if (!user) return reply.code(401).send(errorPayload('UNAUTHENTICATED', 'Please sign in.'));
    return { user: auth.publicUser(user) };
  };
  app.get('/api/auth/me', meHandler);
  app.get('/api/session', meHandler);

  app.post('/api/profile', { onRequest: requireUser, schema: bodySchema(['name'], { name: { type: 'string', maxLength: 120 }, currentPassword: { type: 'string', maxLength: 256 }, password: { anyOf: [password, { type: 'string', maxLength: 0 }] }, rotateRecovery: { type: 'boolean' } }) }, async (request, reply) => {
    const result = await auth.updateProfile(db, request.user.id, request.body);
    // Changing the password signs out every session, so this browser gets a fresh one.
    if (result.passwordChanged) await startSession(reply, request.user.id);
    return { user: auth.publicUser(result.user), recoveryCode: result.recoveryCode };
  });

  app.get('/api/auth/config', async () => ({ googleEnabled: google.enabled() }));
  app.get('/api/auth/google', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const flow = google.start(request.cookies[google.cookieName] || '');
    if (flow.cookie) reply.setCookie(flow.cookie.name, flow.cookie.value, flow.cookie.options);
    return reply.header('Cache-Control', 'no-store').redirect(flow.location);
  });
  app.get('/api/auth/google/callback', async (request, reply) => {
    // Parse the raw query so repeated parameters are visible and rejected.
    const params = new URL(request.url, 'http://localhost').searchParams;
    const result = await google.callback(params, request.cookies[google.cookieName] || '');
    if (result.cookie) reply.setCookie(result.cookie.name, result.cookie.value, result.cookie.options);
    reply.header('Cache-Control', 'no-store');
    if (result.error) return reply.redirect(google.errorLocation(result.error));
    const user = await auth.findOrCreateGoogleUser(db, result.identity);
    if (user.status !== 'active') return reply.redirect(google.errorLocation('google_failed'));
    await auth.deleteSession(db, request.cookies[SESSION_COOKIE]);
    await startSession(reply, user.id);
    await recordAudit(db, { actorId: user.id, action: 'auth.google_login', recordType: 'session' });
    return reply.redirect('/');
  });
}

module.exports = { registerAuthRoutes, SESSION_COOKIE };
