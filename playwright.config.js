// Tier-3 UI tests: Playwright driving desktop VS Code (Electron) with the
// extension loaded in development mode. Run with `npm run test:ui`.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/ui',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1, // one VS Code instance at a time
  retries: process.env.CI ? 2 : 0,
  use: { screenshot: 'only-on-failure' },
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
});
