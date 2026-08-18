'use strict';
// Commentable markdown preview webview: our own DOM — rendered content,
// pre-seeded thread highlight, and the click-through popover.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { buildUiFixture } = require('../integration/fixture');
const { launchVSCode, openFile, runCommand, webviewFrame } = require('./vscodeApp');

test('preview renders markdown with the existing thread highlighted', async () => {
  const workspace = buildUiFixture();
  const { window, close } = await launchVSCode(workspace);
  try {
    await openFile(window, 'notes.md');
    await runCommand(window, 'Comments: Open Markdown Preview');

    const frame = webviewFrame(window);
    await expect(frame.locator('#content')).toContainText('Design notes');

    // The fixture thread anchors "no jitter yet" — it must render as a highlight.
    const highlight = frame.locator('mark.cmt-highlight');
    await expect(highlight.first()).toBeVisible();
    await expect(highlight.first()).toContainText('no jitter yet');

    // Clicking the highlight opens the thread popover with the comment body.
    await highlight.first().click();
    await expect(frame.locator('.cmt-popover')).toContainText('Add jitter before we ship this.');
  } finally {
    await close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
