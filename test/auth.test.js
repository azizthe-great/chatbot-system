const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

test('login, role enforcement, shared knowledge and logout', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, data, cookie) => {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    assert.equal((await request('/api/admin')).status, 401);
    assert.equal((await request('/api/login', { username: 'admin', password: 'wrong' })).status, 401);
    const user = await request('/api/login', { username: 'importer', password: process.env.USER_PASSWORD || 'Importer@2026' });
    assert.equal(user.body.user.role, 'user');
    assert.equal((await request('/api/session', undefined, user.cookie)).body.user.username, 'importer');
    assert.equal((await request('/api/admin', undefined, user.cookie)).status, 403);
    assert.equal((await request('/api/answers', { id: 'fake', answer: 'test' }, user.cookie)).status, 403);
    await request('/api/activity', { intent: 'unresolved', message: 'Can I import a van?' }, user.cookie);
    const admin = await request('/api/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'Admin@2026' });
    const dashboard = await request('/api/admin', undefined, admin.cookie);
    assert.equal(dashboard.status, 200);
    const question = dashboard.body.unresolved.find((item) => item.question === 'Can I import a van?');
    assert.ok(question);
    assert.equal((await request('/api/answers', { id: question.id, answer: 'Demo answer about vans.' }, admin.cookie)).status, 200);
    const knowledge = await request('/api/knowledge', undefined, user.cookie);
    assert.ok(knowledge.body.knowledge.some((item) => item.answer === 'Demo answer about vans.'));
    await request('/api/logout', {}, user.cookie);
    assert.equal((await request('/api/session', undefined, user.cookie)).status, 401);
    assert.equal((await request('/api/session', undefined, admin.cookie)).status, 200);
  } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
});
