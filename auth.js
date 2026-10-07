const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const accounts = [
  { username: 'importer', password: process.env.USER_PASSWORD || 'Importer@2026', role: 'user' },
  { username: 'admin', password: process.env.ADMIN_PASSWORD || 'Admin@2026', role: 'admin' }
].map(({ password, ...account }) => {
  const salt = randomBytes(16);
  return { ...account, salt, hash: scryptSync(password, salt, 64) };
});
const sessions = new Map();
function authenticate(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256) return null;
  const account = accounts.find((item) => item.username === username.trim().toLowerCase());
  if (!account || !timingSafeEqual(scryptSync(password, account.salt, 64), account.hash)) return null;
  return { username: account.username, role: account.role };
}
function sessionId(request) {
  return (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('portside_session='))?.slice(17);
}
function currentUser(request) {
  const id = sessionId(request); const session = sessions.get(id);
  if (!session) return null;
  if (session.expires <= Date.now()) { sessions.delete(id); return null; }
  return session.user;
}
function login(user) {
  for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
  const id = randomBytes(32).toString('hex'); sessions.set(id, { user, expires: Date.now() + 8 * 60 * 60 * 1000 }); return id;
}
function logout(request) { sessions.delete(sessionId(request)); }
module.exports = { authenticate, currentUser, login, logout };
