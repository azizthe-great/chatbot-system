const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const { setup } = require('./support/app');

test('Google authorization code login validates the browser and identity before creating a private account', async (t) => {
  const originalEnv = Object.fromEntries(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'NODE_ENV'].map((key) => [key, process.env[key]]));
  const realFetch = global.fetch, realNow = Date.now;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'google-test-key', alg: 'RS256', use: 'sig' };
  let tokenResult, tokenStatus = 200, tokenCalls = [], keyCalls = 0;
  const ctx = await setup(t), db = ctx.db;
  const base = 'http://127.0.0.1:3000';
  const configure = () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'server-only-secret';
    process.env.GOOGLE_REDIRECT_URI = `${base}/api/auth/google/callback`;
    process.env.NODE_ENV = 'test';
  };
  const request = async (route, options = {}) => {
    const response = await ctx.app.inject({ method: options.method || 'GET', url: route, headers: options.headers || {}, ...(options.body ? { payload: options.body } : {}) });
    const cookies = [].concat(response.headers['set-cookie'] || []);
    return { status: response.statusCode, text: async () => response.body, json: async () => response.json(), headers: { get: (name) => name === 'set-cookie' ? (cookies.length ? cookies.join(', ') : null) : response.headers[name] ?? null } };
  };
  const cookie = (response, name) => new RegExp(`(?:^|,\\s*)(${name}=[^;,]*)`).exec(response.headers.get('set-cookie') || '')?.[1];
  const getJson = async (route, session) => {
    const response = await request(route, { headers: session ? { Cookie: session } : {} });
    return { status: response.status, body: await response.json() };
  };
  const post = async (route, data, session) => {
    const response = await request(route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}) }, body: JSON.stringify(data) });
    return { response: { status: response.status }, body: await response.json() };
  };
  const begin = async () => {
    const response = await request('/api/auth/google');
    assert.equal(response.status, 302);
    return { response, destination: new URL(response.headers.get('location')), browser: cookie(response, 'portside_google_oauth') };
  };
  const jwt = (flow, override = {}, customHeader = {}, badSignature = false) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT', ...customHeader })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, sub: 'google-person-one', email: 'person@example.com', email_verified: true, name: 'Google Person', iat: now, exp: now + 3600, nonce: flow.destination.searchParams.get('nonce'), ...override })).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
    if (badSignature) signature[0] ^= 1;
    return `${header}.${payload}.${signature.toString('base64url')}`;
  };
  const finish = (flow, extra = '', browser = flow.browser) => request(`/api/auth/google/callback?state=${flow.destination.searchParams.get('state')}&code=mock-code${extra}`, { headers: browser ? { Cookie: browser } : {} });
  global.fetch = async (url, options) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      tokenCalls.push(new URLSearchParams(options.body));
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify(tokenResult), { status: tokenStatus, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs') {
      keyCalls++;
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'application/json' } });
    }
    throw new Error('Unexpected outbound request.');
  };
  try {
    await t.test('configuration exposes only availability and rejects unsafe callback URLs', async () => {
      delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; delete process.env.GOOGLE_REDIRECT_URI;
      assert.deepEqual((await getJson('/api/auth/config')).body, { googleEnabled: false });
      assert.equal((await request('/api/auth/google')).headers.get('location'), '/?auth_error=google_unavailable#login');
      configure();
      assert.deepEqual((await getJson('/api/auth/config')).body, { googleEnabled: true });
      process.env.GOOGLE_REDIRECT_URI = 'http://attacker.example/api/auth/google/callback';
      assert.deepEqual((await getJson('/api/auth/config')).body, { googleEnabled: false });
      process.env.GOOGLE_REDIRECT_URI = 'https://app.example/api/auth/google/callback?extra=1';
      assert.equal((await getJson('/api/auth/config')).body.googleEnabled, false);
      configure();
    });
    let firstUser, firstSession;
    await t.test('successful login uses state, nonce, PKCE, private server exchange and verified RS256 identity', async () => {
      const flow = await begin(), params = flow.destination.searchParams;
      assert.equal(flow.destination.origin, 'https://accounts.google.com');
      assert.equal(params.get('scope'), 'openid email profile');
      assert.equal(params.get('response_type'), 'code');
      assert.equal(params.get('redirect_uri'), process.env.GOOGLE_REDIRECT_URI);
      assert.equal(params.get('code_challenge_method'), 'S256');
      assert.ok(!flow.response.headers.get('location').includes(process.env.GOOGLE_CLIENT_SECRET));
      assert.match(flow.response.headers.get('set-cookie'), /Max-Age=600; Path=\/api\/auth\/google; HttpOnly; SameSite=Lax/);
      tokenResult = { id_token: jwt(flow), access_token: 'never-expose-this', refresh_token: 'never-save-this' };
      const response = await finish(flow);
      assert.equal(response.headers.get('location'), '/');
      assert.match(response.headers.get('set-cookie'), /portside_google_oauth=;.*Max-Age=0/);
      assert.match(response.headers.get('set-cookie'), /portside_session=.*HttpOnly; SameSite=Strict/);
      firstSession = cookie(response, 'portside_session');
      const session = await getJson('/api/session', firstSession); firstUser = session.body.user;
      assert.equal(firstUser.authProvider, 'google'); assert.equal(firstUser.role, 'customer'); assert.equal(firstUser.email, 'person@example.com');
      assert.ok(!JSON.stringify(session).includes('never-expose-this'));
      for (const table of ['users', 'sessions', 'audit_events']) assert.ok(!JSON.stringify((await db.query(`SELECT * FROM ${table}`)).rows).includes('never-save-this'));
      const exchange = tokenCalls.at(-1);
      assert.equal(exchange.get('client_secret'), process.env.GOOGLE_CLIENT_SECRET);
      assert.equal(exchange.get('redirect_uri'), process.env.GOOGLE_REDIRECT_URI);
      assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), params.get('code_challenge'));
      assert.equal((await getJson('/api/admin', firstSession)).status, 403);
      const replay = await finish(flow); assert.equal(replay.headers.get('location'), '/?auth_error=google_invalid#login');
      assert.equal(tokenCalls.length, 1);
    });
    await t.test('subject stays stable when email changes and matching emails never link local or Google accounts', async () => {
      await db.query("UPDATE users SET email='shared@example.com' WHERE role='admin'");
      let flow = await begin(); tokenResult = { id_token: jwt(flow, { email: 'shared@example.com' }) };
      let response = await finish(flow), session = cookie(response, 'portside_session');
      assert.equal((await getJson('/api/session', session)).body.user.id, firstUser.id);
      assert.equal((await getJson('/api/session', session)).body.user.email, 'shared@example.com');
      assert.equal((await getJson('/api/session', session)).body.user.role, 'customer');
      flow = await begin(); tokenResult = { id_token: jwt(flow, { sub: 'google-person-two', email: 'shared@example.com' }) };
      response = await finish(flow); session = cookie(response, 'portside_session');
      const second = (await getJson('/api/session', session)).body.user;
      assert.notEqual(second.id, firstUser.id); assert.equal(second.role, 'customer');
      const created = await post('/api/conversations', {}, firstSession);
      assert.equal((await getJson(`/api/conversations/${created.body.conversation.id}`, session)).status, 404);
      assert.equal(keyCalls, 1, 'Google keys are cached between logins');
    });
    await t.test('Google profile name updates remain usable while password and recovery changes are blocked', async () => {
      const changed = await post('/api/profile', { name: 'My chosen name' }, firstSession);
      assert.equal(changed.response.status, 200); assert.equal(changed.body.user.name, 'My chosen name');
      const blocked = await post('/api/profile', { name: 'Wrong name', password: 'AttackerPassword123!', rotateRecovery: true }, firstSession);
      assert.equal(blocked.response.status, 400);
      assert.equal((await getJson('/api/session', firstSession)).body.user.name, 'My chosen name');
      const account = (await db.query('SELECT password_hash,recovery_hash FROM users WHERE id=$1', [firstUser.id])).rows[0];
      assert.equal(account.password_hash, null); assert.equal(account.recovery_hash, null);
      assert.equal((await post('/api/auth/login', { email: 'shared@example.com', password: 'AttackerPassword123!' })).response.status, 401);
    });
    await t.test('state must match the browser and callbacks expire or cancel without creating a session', async () => {
      let flow = await begin(); tokenResult = { id_token: jwt(flow) };
      const before = tokenCalls.length;
      const mismatched = await finish(flow, '', 'portside_google_oauth=wrong-browser');
      assert.equal(mismatched.headers.get('location'), '/?auth_error=google_invalid#login');
      assert.equal(mismatched.headers.get('set-cookie'), null, 'an invalid callback must not cancel a valid browser flow');
      assert.equal((await finish(flow, '&state=duplicate')).headers.get('location'), '/?auth_error=google_invalid#login');
      assert.equal(tokenCalls.length, before);
      assert.equal((await finish(flow)).headers.get('location'), '/');
      flow = await begin();
      const cancelled = await request(`/api/auth/google/callback?state=${flow.destination.searchParams.get('state')}&error=access_denied`, { headers: { Cookie: flow.browser } });
      assert.equal(cancelled.headers.get('location'), '/?auth_error=google_cancelled#login'); assert.equal(cookie(cancelled, 'portside_session'), undefined);
      flow = await begin(); Date.now = () => realNow() + 600001;
      const expired = await finish(flow); Date.now = realNow;
      assert.equal(expired.headers.get('location'), '/?auth_error=google_invalid#login');
    });
    await t.test('forged, wrong-audience, wrong-issuer, expired and replayed-nonce tokens are rejected', async () => {
      for (const scenario of [
        { label: 'signature', badSignature: true },
        { label: 'algorithm', header: { alg: 'HS256' } },
        { label: 'issuer', claims: { iss: 'https://attacker.example' } },
        { label: 'audience', claims: { aud: 'another-client' } },
        { label: 'expiry', claims: { exp: Math.floor(Date.now() / 1000) - 1 } },
        { label: 'nonce', claims: { nonce: 'nonce-from-another-login' } },
        { label: 'authorized party', claims: { aud: [process.env.GOOGLE_CLIENT_ID, 'another-client'], azp: 'another-client' } }
      ]) {
        const flow = await begin(); tokenResult = { id_token: jwt(flow, scenario.claims, scenario.header, scenario.badSignature) };
        const response = await finish(flow);
        assert.equal(response.headers.get('location'), '/?auth_error=google_failed#login', scenario.label);
        assert.equal(cookie(response, 'portside_session'), undefined, scenario.label);
      }
    });
    await t.test('unverified email and provider failures do not expose tokens or provider errors', async () => {
      let flow = await begin(); tokenResult = { id_token: jwt(flow, { email_verified: false }) };
      assert.equal((await finish(flow)).headers.get('location'), '/?auth_error=google_email_unverified#login');
      flow = await begin(); tokenStatus = 400; tokenResult = { error: 'sensitive-provider-detail' };
      const failed = await finish(flow);
      assert.equal(failed.headers.get('location'), '/?auth_error=google_failed#login');
      assert.equal(await failed.text(), ''); tokenStatus = 200;
    });
    await t.test('HTTPS config uses a Secure browser cookie and ignores forged forwarded headers', async () => {
      process.env.GOOGLE_REDIRECT_URI = 'https://portside.example/api/auth/google/callback';
      const response = await request('/api/auth/google', { headers: { 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'http' } });
      assert.match(response.headers.get('set-cookie'), /; Secure/);
      const destination = new URL(response.headers.get('location'));
      assert.equal(destination.searchParams.get('redirect_uri'), 'https://portside.example/api/auth/google/callback');
    });
  } finally {
    Date.now = realNow; global.fetch = realFetch;
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
