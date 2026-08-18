'use strict';
// Conversation graph webview: open a vendored session via the palette
// quick-pick and assert the graph renders message nodes (our own DOM).
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { buildUiFixture } = require('../integration/fixture');
const { launchVSCode, runCommand, webviewFrame } = require('./vscodeApp');

test('vendored session opens as a conversation graph with message nodes', async () => {
  const workspace = buildUiFixture();
  const { window, close } = await launchVSCode(workspace);
  try {
    await runCommand(window, 'Comments: Open Claude Conversation');

    // Our new no-arg path shows a quick-pick of vendored sessions — take the first.
    await window.waitForSelector('.quick-input-widget:not(.hidden)', { timeout: 15_000 });
    await window.keyboard.press('Enter');

    const frame = webviewFrame(window);
    await expect(frame.locator('#app')).toBeVisible();
    // Message nodes carry data-uuid (fixture session has a multi-message spine).
    await expect
      .poll(async () => frame.locator('[data-uuid]').count(), { timeout: 30_000 })
      .toBeGreaterThan(2);
  } finally {
    await close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
