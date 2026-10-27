'use strict';
const { randomBytes, createHash, randomUUID } = require('node:crypto');
const { hashPassword, verifyPassword } = require('./passwords');
const { recordAudit } = require('./audit');
const { withTransaction } = require('../database/transaction');
const DUMMY_PASSWORD_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
const USER_COLUMNS = 'id,name,email,role,status,google_subject';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const newRecoveryCode = () => randomBytes(24).toString('hex');
const passwordValid = (password) => typeof password === 'string' && password.length >= 12 && password.length <= 256;
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, authProvider: user.google_subject ? 'google' : 'password' };
}
async function createUser(db, { name, email, password, role = 'customer', recoveryCode }) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || !passwordValid(password) || !['customer', 'admin'].includes(role)) throw new Error('Name, valid email, role and password of at least 12 characters are required.');
  const passwordHash = await hashPassword(password);
  const recoveryHash = recoveryCode ? await hashPassword(recoveryCode) : null;
  const id = randomUUID();
  return withTransaction(db, async (client) => {
    const result = await client.query(
      `INSERT INTO users (id,name,email,password_hash,role,recovery_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${USER_COLUMNS},created_at`,
      [id, name.trim(), normalizedEmail, passwordHash, role, recoveryHash]
    );
    if (role === 'customer') await client.query('INSERT INTO customer_profiles (id,user_id) VALUES ($1,$2)', [randomUUID(), id]);
    return result.rows[0];
  });
}
async function registerCustomer(db, { name, email, password }) {
  const recoveryCode = newRecoveryCode();
  const user = await createUser(db, { name, email, password, role: 'customer', recoveryCode });
  return { user, recoveryCode };
}
async function authenticate(db, email, password) {
  const result = await db.query(`SELECT ${USER_COLUMNS},password_hash FROM users WHERE lower(email)=$1 AND google_subject IS NULL`, [email.trim().toLowerCase()]);
  const user = result.rows[0];
  const valid = await verifyPassword(password, user?.password_hash || DUMMY_PASSWORD_HASH);
  if (!user || user.status !== 'active' || !valid) return null;
  const { password_hash, ...safeUser } = user;
  return safeUser;
}
async function resetPassword(db, { email, recoveryCode, password }) {
  const result = await db.query("SELECT id,recovery_hash FROM users WHERE lower(email)=$1 AND google_subject IS NULL AND status='active'", [String(email).trim().toLowerCase()]);
  const user = result.rows[0];
  const valid = await verifyPassword(String(recoveryCode), user?.recovery_hash || DUMMY_PASSWORD_HASH);
  if (!user || !valid) throw invalid('Email or recovery code is incorrect.');
  if (!passwordValid(password)) throw invalid('Use a password between 12 and 256 characters.');
  const nextCode = newRecoveryCode();
  // The hash comparison guards against two resets spending the same code concurrently.
  const updated = await db.query('UPDATE users SET password_hash=$1,recovery_hash=$2,updated_at=now() WHERE id=$3 AND recovery_hash=$4', [await hashPassword(password), await hashPassword(nextCode), user.id, user.recovery_hash]);
  if (!updated.rowCount) throw invalid('Email or recovery code is incorrect.');
  await deleteUserSessions(db, user.id);
  await recordAudit(db, { actorId: user.id, action: 'auth.password_reset', recordType: 'user', recordId: user.id });
  return { recoveryCode: nextCode };
}
async function updateProfile(db, userId, { name, currentPassword, password, rotateRecovery }) {
  const result = await db.query(`SELECT ${USER_COLUMNS},password_hash FROM users WHERE id=$1 AND status='active'`, [userId]);
  const user = result.rows[0];
  if (!user) throw Object.assign(new Error('Your account is unavailable. Please sign in again.'), { statusCode: 401 });
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw invalid('Enter a name of up to 120 characters.');
  if (user.google_subject && (password || rotateRecovery)) throw invalid('Use your Google account to manage your password and account recovery.');
  if ((password || rotateRecovery) && !(await verifyPassword(String(currentPassword || ''), user.password_hash))) throw invalid('Current password is incorrect.');
  if (password && !passwordValid(password)) throw invalid('Use a password between 12 and 256 characters.');
  const recoveryCode = rotateRecovery ? newRecoveryCode() : undefined;
  const updated = await db.query(
    `UPDATE users SET name=$1,
       password_hash=COALESCE($2,password_hash),
       recovery_hash=COALESCE($3,recovery_hash),
       updated_at=now()
     WHERE id=$4 RETURNING ${USER_COLUMNS}`,
    [name.trim(), password ? await hashPassword(password) : null, recoveryCode ? await hashPassword(recoveryCode) : null, userId]
  );
  if (password) await deleteUserSessions(db, userId);
  await recordAudit(db, { actorId: userId, action: 'user.profile_update', recordType: 'user', recordId: userId, metadata: { passwordChanged: Boolean(password), recoveryRotated: Boolean(recoveryCode) } });
  return { user: updated.rows[0], recoveryCode, passwordChanged: Boolean(password) };
}
async function findOrCreateGoogleUser(db, { sub, email, name }) {
  const normalizedEmail = email.trim().toLowerCase();
  // A Google subject is the identity. Matching email addresses never link accounts.
  const existing = await db.query(`UPDATE users SET email=$1,updated_at=now() WHERE google_subject=$2 RETURNING ${USER_COLUMNS}`, [normalizedEmail, sub]);
  if (existing.rowCount) return existing.rows[0];
  const displayName = (typeof name === 'string' && name.trim() ? name.trim() : normalizedEmail.split('@')[0]).slice(0, 120);
  const id = randomUUID();
  return withTransaction(db, async (client) => {
    const result = await client.query(
      `INSERT INTO users (id,name,email,role,google_subject) VALUES ($1,$2,$3,'customer',$4)
       ON CONFLICT (google_subject) DO UPDATE SET email=EXCLUDED.email,updated_at=now() RETURNING ${USER_COLUMNS}`,
      [id, displayName, normalizedEmail, sub]
    );
    const user = result.rows[0];
    if (user.id === id) await client.query('INSERT INTO customer_profiles (id,user_id) VALUES ($1,$2)', [randomUUID(), id]);
    return user;
  });
}
async function createSession(db, userId, ttlHours) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  await db.query('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)', [hashToken(token), userId, expiresAt]);
  return { token, expiresAt };
}
async function findSession(db, token) {
  if (!token || token.length > 128) return null;
  const result = await db.query(
    `SELECT u.id,u.name,u.email,u.role,u.status,u.google_subject,s.expires_at
       FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='active'`,
    [hashToken(token)]
  );
  return result.rows[0] || null;
}
async function deleteSession(db, token) {
  if (token && token.length <= 128) await db.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]);
}
async function deleteUserSessions(db, userId) {
  await db.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
}

module.exports = {
  createUser, registerCustomer, authenticate, resetPassword, updateProfile, findOrCreateGoogleUser,
  createSession, findSession, deleteSession, deleteUserSessions, hashToken, publicUser
};
