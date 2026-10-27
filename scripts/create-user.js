'use strict';
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { getPool, closePool } = require('../src/database/pool');
const { createUser } = require('../src/services/auth');

function secretPrompt(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return Promise.reject(new Error('Run this command in an interactive terminal so the password can be entered safely.'));
  stdout.write(label);
  stdin.setRawMode(true); stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const restore = () => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdout.write('\n'); };
    const onData = (chunk) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { restore(); reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { restore(); resolve(value); return; }
        if (char === '\u0008' || char === '\u007f') { value = value.slice(0, -1); continue; }
        if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const role = process.argv[2];
  if (!['admin', 'customer'].includes(role)) throw new Error('Choose the role with npm run users:create-admin or npm run users:create-customer.');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const name = (await rl.question('Name: ')).trim();
    const email = (await rl.question('Email: ')).trim();
    rl.close();
    const password = await secretPrompt('Password (hidden; minimum 12 characters): ');
    const confirmation = await secretPrompt('Confirm password: ');
    if (!name || !email || password.length < 12 || password !== confirmation) throw new Error('Name, email and matching password of at least 12 characters are required.');
    const user = await createUser(getPool(), { name, email, password, role });
    console.log(`Created ${user.role} account ${user.email} (${user.id}).`);
  } finally { rl.close(); await closePool(); }
})().catch((error) => { console.error(`Could not create account: ${error.code === '23505' ? 'email already exists.' : error.message}`); process.exitCode = 1; });
