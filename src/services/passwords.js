'use strict';
const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const scryptAsync = promisify(scrypt);
async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const [scheme, saltHex, expectedHex] = String(encoded || '').split('$');
  if (scheme !== 'scrypt' || !/^[0-9a-f]{32}$/i.test(saltHex || '') || !/^[0-9a-f]{128}$/i.test(expectedHex || '')) return false;
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
}
module.exports = { hashPassword, verifyPassword };
