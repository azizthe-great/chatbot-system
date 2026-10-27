'use strict';
const { randomBytes, createHash, timingSafeEqual, createPublicKey, verify } = require('node:crypto');

// Google discovery metadata: https://accounts.google.com/.well-known/openid-configuration
// Fixed Google endpoints avoid trusting URLs from requests or ID-token headers.
const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const jwksEndpoint = 'https://www.googleapis.com/oauth2/v3/certs';
const cookieName = 'portside_google_oauth';
const lifetime = 10 * 60 * 1000;
const pending = new Map();
let cachedKeys = [], keysExpire = 0, keysRequest;

function configuration() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim(), clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim(), redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/auth/google/callback') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && process.env.NODE_ENV !== 'production')) return null;
    return { clientId, clientSecret, redirectUri, secure: url.protocol === 'https:' };
  } catch { return null; }
}
function errorLocation(error) { return `/?auth_error=${error}#login`; }
function browserCookie(value, secure) {
  return { name: cookieName, value, options: { httpOnly: true, sameSite: 'lax', path: '/api/auth/google', maxAge: value ? lifetime / 1000 : 0, secure } };
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
// Returns where to send the browser and the cookie that binds the flow to it.
function start(previousBrowser) {
  const config = configuration();
  if (!config) return { location: errorLocation('google_unavailable') };
  const now = Date.now();
  for (const [state, entry] of pending) if (entry.expires <= now || equal(entry.browser, previousBrowser)) pending.delete(state);
  if (pending.size >= 1000) return { location: errorLocation('google_unavailable') };
  const state = randomBytes(32).toString('base64url'), browser = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  pending.set(state, { browser, nonce, verifier, expires: now + lifetime, clientId: config.clientId, redirectUri: config.redirectUri });
  const destination = new URL(authorizationEndpoint);
  destination.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'online', prompt: 'select_account' }).toString();
  return { location: destination.href, cookie: browserCookie(browser, config.secure) };
}
async function googleJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Google request failed.');
  const body = await response.text();
  if (body.length > 65536) throw new Error('Invalid Google response.');
  const data = JSON.parse(body);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Google response.');
  return { data, headers: response.headers };
}
async function keys(refresh = false) {
  if (!refresh && keysExpire > Date.now()) return cachedKeys;
  if (!keysRequest) keysRequest = (async () => {
    const { data, headers } = await googleJson(jwksEndpoint);
    if (!Array.isArray(data.keys) || !data.keys.length || data.keys.length > 20) throw new Error('Invalid Google signing keys.');
    cachedKeys = data.keys;
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(headers.get('cache-control') || '');
    keysExpire = Date.now() + Math.min(86400, maxAge ? Number(maxAge[1]) : 3600) * 1000;
    return cachedKeys;
  })().finally(() => { keysRequest = null; });
  return keysRequest;
}
async function identity(token, config, nonce) {
  if (typeof token !== 'string' || token.length > 16384) throw new Error('Invalid identity token.');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid identity token.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 200 || header.crit || header.b64 === false) throw new Error('Invalid token signature.');
  const suitable = (key) => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig') && (!key.key_ops || (Array.isArray(key.key_ops) && key.key_ops.includes('verify')));
  let jwk = (await keys()).find(suitable);
  if (!jwk) jwk = (await keys(true)).find(suitable);
  if (!jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid token signature.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), now = Math.floor(Date.now() / 1000);
  if (!claims || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) throw new Error('Invalid token issuer.');
  const audience = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (!Array.isArray(audience) || !audience.length || !audience.every((value) => typeof value === 'string') || !audience.includes(config.clientId) || (audience.length > 1 && claims.azp !== config.clientId) || (claims.azp !== undefined && claims.azp !== config.clientId)) throw new Error('Invalid token audience.');
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 || claims.iat >= claims.exp || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 60))) throw new Error('Expired or invalid identity token.');
  if (!equal(claims.nonce, nonce) || typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) throw new Error('Invalid identity token.');
  if (claims.email_verified !== true || typeof claims.email !== 'string' || claims.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) {
    const error = new Error('A verified Google email is required.'); error.authError = 'google_email_unverified'; throw error;
  }
  return claims;
}
// Resolves to { identity } on success or { error } naming the failure; cookie, when set, clears the flow cookie.
async function callback(params, browser) {
  const config = configuration();
  if (!config) return { error: 'google_unavailable' };
  const state = params.get('state'), entry = pending.get(state);
  if (params.getAll('state').length !== 1 || !entry || entry.expires <= Date.now() || !equal(entry.browser, browser) || entry.clientId !== config.clientId || entry.redirectUri !== config.redirectUri) {
    if (entry?.expires <= Date.now()) pending.delete(state);
    return { error: 'google_invalid' };
  }
  // Consume before network I/O so concurrent callbacks cannot replay the flow.
  pending.delete(state);
  const cookie = browserCookie('', config.secure);
  if (params.getAll('error').length > 1 || params.getAll('code').length > 1 || params.getAll('iss').length > 1 || (params.has('iss') && params.get('iss') !== 'https://accounts.google.com')) return { error: 'google_invalid', cookie };
  if (params.has('error')) return { error: params.get('error') === 'access_denied' ? 'google_cancelled' : 'google_failed', cookie };
  const code = params.get('code');
  if (!code || code.length > 4096) return { error: 'google_invalid', cookie };
  try {
    const body = new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code', code_verifier: entry.verifier });
    const { data } = await googleJson(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    return { identity: await identity(data.id_token, config, entry.nonce), cookie };
  } catch (error) { return { error: error.authError === 'google_email_unverified' ? error.authError : 'google_failed', cookie }; }
}
module.exports = { enabled: () => !!configuration(), start, callback, errorLocation, cookieName };
