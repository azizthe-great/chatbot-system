const { defineConfig } = require('@playwright/test');
const { existsSync } = require('node:fs');
const chrome = process.env.PORTSIDE_CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
module.exports = defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3107', browserName: 'chromium', launchOptions: chrome ? { executablePath: chrome } : {}, trace: 'retain-on-failure' },
  webServer: { command: 'node e2e/server.js', url: 'http://127.0.0.1:3107', reuseExistingServer: false, env: { PORT: '3107' } }
});
