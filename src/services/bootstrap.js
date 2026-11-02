'use strict';
const { createUser } = require('./auth');

// Creates the administrator from the ADMIN_* settings so a new install needs no setup command.
// An existing account is never changed, so a password changed in Account settings stays changed.
async function ensureAdmin(db, admin) {
  const email = admin.email.trim().toLowerCase();
  if (!email && !admin.password) {
    const existing = await db.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
    return existing.rowCount ? { status: 'exists' } : { status: 'missing' };
  }
  if (!email || !admin.password) throw new Error('Set both ADMIN_EMAIL and ADMIN_PASSWORD in .env to create the administrator.');
  const found = await db.query('SELECT role FROM users WHERE lower(email)=$1 AND google_subject IS NULL', [email]);
  if (found.rowCount) return { status: found.rows[0].role === 'admin' ? 'exists' : 'customer', email };
  if (admin.password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  await createUser(db, { name: admin.name, email, password: admin.password, role: 'admin' });
  return { status: 'created', email };
}

module.exports = { ensureAdmin };
