'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Load local .env without replacing values already supplied by the process.
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

module.exports = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 3000,
  // Local development works without an environment file; override for other environments.
  databaseUrl: process.env.DATABASE_URL || 'postgres://portside_user:portside_local_dev@127.0.0.1:5432/portside',
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionTtlHours: Math.max(1, Number(process.env.SESSION_TTL_HOURS) || 8),
  cookieSecure: process.env.COOKIE_SECURE === 'true' || (process.env.NODE_ENV || '').toLowerCase() === 'production',
  trustProxy: process.env.TRUST_PROXY === 'true',
  logLevel: process.env.LOG_LEVEL || 'info'
};
