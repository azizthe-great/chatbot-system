'use strict';
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { getPool, closePool } = require('../src/database/pool');
const { resetAdminPassword } = require('../src/services/auth');

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
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const identifier = (await rl.question('Administrator email or account ID: ')).trim();
    rl.close();
    const password = await secretPrompt('New password (hidden; minimum 12 characters): ');
    const confirmation = await secretPrompt('Confirm new password: ');
    if (password !== confirmation) throw new Error('The passwords do not match.');
    const user = await resetAdminPassword(getPool(), { identifier, password });
    console.log(`Password updated for existing administrator ${user.email} (${user.id}).`);
  } finally { rl.close(); await closePool(); }
})().catch((error) => { console.error(`Could not reset administrator password: ${error.message}`); process.exitCode = 1; });
