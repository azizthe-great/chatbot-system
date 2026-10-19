const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { state, save } = require('./store');
function hash(value) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`; }
function matches(value, encoded) {
  if (typeof value !== 'string' || value.length > 256 || !encoded) return false;
  const [salt, digest] = encoded.split(':');
  return timingSafeEqual(scryptSync(value, salt, 64), Buffer.from(digest, 'hex'));
}
for (const account of [
  { username: 'importer', password: process.env.USER_PASSWORD || 'Importer@2026', role: 'user' },
  { username: 'admin', password: process.env.ADMIN_PASSWORD || 'Admin@2026', role: 'admin' }
]) if (!state.accounts.some((item) => item.username === account.username)) {
  state.accounts.push({ username: account.username, name: account.username, role: account.role, passwordHash: hash(account.password) }); save();
}
const sessions = new Map();
const publicUser = ({ username, name, role, googleSubject, email }) => ({ username, name, role, authProvider: googleSubject ? 'google' : 'password', ...(googleSubject ? { email } : {}) });
function authenticate(username, password) {
  const account = state.accounts.find((item) => item.username === String(username).trim().toLowerCase());
  return account && matches(password, account.passwordHash) ? publicUser(account) : null;
}
function passwordValid(password) { return typeof password === 'string' && password.length >= 12 && password.length <= 128; }
function register({ username, password, name }) {
  username = String(username || '').trim().toLowerCase(); name = String(name || '').trim();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new Error('Use 3–32 letters, numbers or underscores for your username.');
  if (!passwordValid(password)) throw new Error('Use a password between 12 and 128 characters.');
  if (!name || name.length > 80) throw new Error('Enter a name of up to 80 characters.');
  if (state.accounts.some((item) => item.username === username)) throw new Error('That username is unavailable.');
  const recoveryCode = randomBytes(24).toString('hex');
  const account = { username, name, role: 'user', passwordHash: hash(password), recoveryHash: hash(recoveryCode) };
  state.accounts.push(account); save(); return { user: publicUser(account), recoveryCode };
}
function reset({ username, recoveryCode, password }) {
  const account = state.accounts.find((item) => item.username === String(username).trim().toLowerCase());
  if (!account || !matches(recoveryCode, account.recoveryHash)) throw new Error('Username or recovery code is incorrect.');
  if (!passwordValid(password)) throw new Error('Use a password between 12 and 128 characters.');
  const nextCode = randomBytes(24).toString('hex');
  account.passwordHash = hash(password); account.recoveryHash = hash(nextCode); revoke(account.username); save();
  return { recoveryCode: nextCode };
}
function google({ sub, email, name }) {
  // A Google subject is the identity. Matching email addresses never links accounts.
  let account = state.accounts.find((item) => item.googleSubject === sub);
  if (!account) {
    let username;
    do { username = `google_${randomBytes(12).toString('hex')}`; } while (state.accounts.some((item) => item.username === username));
    account = { username, name: (typeof name === 'string' && name.trim() ? name.trim() : email.split('@')[0]).slice(0, 80), role: 'user', googleSubject: sub, email };
    state.accounts.push(account);
  } else account.email = email;
  save(); return publicUser(account);
}
function update(user, { name, currentPassword, password, rotateRecovery }) {
  const account = state.accounts.find((item) => item.username === user.username);
  if (!account) throw new Error('Your account is unavailable. Please sign in again.');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Enter a name of up to 80 characters.');
  if (account.googleSubject && (password || rotateRecovery)) throw new Error('Use your Google account to manage your password and account recovery.');
  if ((password || rotateRecovery) && !matches(currentPassword, account.passwordHash)) throw new Error('Current password is incorrect.');
  if (password && !passwordValid(password)) throw new Error('Use a password between 12 and 128 characters.');
  account.name = name.trim();
  if (password) { account.passwordHash = hash(password); revoke(user.username); }
  let recoveryCode;
  if (rotateRecovery) { recoveryCode = randomBytes(24).toString('hex'); account.recoveryHash = hash(recoveryCode); }
  save(); return { user: publicUser(account), recoveryCode };
}
function sessionId(request) { return (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('portside_session='))?.slice(17); }
function currentUser(request) {
  const id = sessionId(request), session = sessions.get(id);
  if (!session) return null;
  if (session.expires <= Date.now()) { sessions.delete(id); return null; }
  const account = state.accounts.find((item) => item.username === session.username);
  return account ? publicUser(account) : null;
}
function login(user) {
  for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
  const id = randomBytes(32).toString('hex'); sessions.set(id, { username: user.username, expires: Date.now() + 8 * 60 * 60 * 1000 }); return id;
}
function revoke(username) { for (const [id, session] of sessions) if (session.username === username) sessions.delete(id); }
function logout(request) { sessions.delete(sessionId(request)); }
module.exports = { authenticate, currentUser, login, logout, register, reset, update, google };
