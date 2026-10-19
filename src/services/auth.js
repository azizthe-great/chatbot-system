'use strict';
const { randomBytes, createHash, randomUUID } = require('node:crypto');
const { hashPassword, verifyPassword } = require('./passwords');
const { recordAudit } = require('./audit');
const DUMMY_PASSWORD_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
async function createUser(db, { name, email, password, role = 'customer' }) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || typeof password !== 'string' || password.length < 12 || !['customer', 'admin'].includes(role)) throw new Error('Name, valid email, role and password of at least 12 characters are required.');
  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try {
    if (client !== db) await client.query('BEGIN');
    const result = await client.query(
      'INSERT INTO users (id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,email,role,status,created_at',
      [id, name.trim(), normalizedEmail, passwordHash, role]
    );
    if (role === 'customer') await client.query('INSERT INTO customer_profiles (id,user_id) VALUES ($1,$2)', [randomUUID(), id]);
    if (client !== db) await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    if (client !== db) await client.query('ROLLBACK');
    throw error;
  } finally { if (client !== db) client.release(); }
}
async function authenticate(db, email, password) {
  const result = await db.query('SELECT id,name,email,password_hash,role,status FROM users WHERE lower(email)=$1', [email.trim().toLowerCase()]);
  const user = result.rows[0];
  const valid = await verifyPassword(password, user?.password_hash || DUMMY_PASSWORD_HASH);
  if (!user || user.status !== 'active' || !valid) return null;
  const { password_hash, ...safeUser } = user;
  return safeUser;
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
    `SELECT u.id,u.name,u.email,u.role,u.status,s.expires_at
       FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='active'`,
    [hashToken(token)]
  );
  return result.rows[0] || null;
}
async function deleteSession(db, token) {
  if (token && token.length <= 128) await db.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]);
}

module.exports = { createUser, authenticate, createSession, findSession, deleteSession, hashToken };
