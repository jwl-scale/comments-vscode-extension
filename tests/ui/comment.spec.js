'use strict';
// Golden-path native-UI smoke: select text → keybinding opens the comment
// widget → type → submit → the v2 event log lands on disk. Disk is the
// assertion target (our contract); the DOM is only driven, not deeply probed.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { buildUiFixture } = require('../integration/fixture');
const { launchVSCode, openFile, MOD } = require('./vscodeApp');

test('select → ⌘⌥M → type → submit creates a thread event log', async () => {
  const workspace = buildUiFixture();
  const { window, close } = await launchVSCode(workspace);
  try {
    await openFile(window, 'src/app.ts');

    // Select the whole document, then open the comment widget via keybinding.
    await window.keyboard.press(`${MOD}+A`);
    await window.keyboard.press(`${MOD}+Alt+M`);
    const form = window.locator('.comment-form .monaco-editor').first();
    await form.waitFor({ timeout: 15_000 });

    // Focus the comment editor explicitly — the widget animates in and focus
    // can lag the DOM, which would send keystrokes to the file editor.
    await form.click();
    await window.waitForTimeout(500);
    const body = 'ui-smoke: does main need error handling?';
    await window.keyboard.type(body, { delay: 15 });
    await window.keyboard.press(`${MOD}+Enter`); // submit comment

    // The contract: a thread event log appears with our text and a baseline.
    const threadsDir = path.join(workspace, '.comments', 'threads');
    await expect
      .poll(
        () => {
          if (!fs.existsSync(threadsDir)) return null;
          for (const f of fs.readdirSync(threadsDir)) {
            if (!f.endsWith('.jsonl')) continue;
            const first = fs.readFileSync(path.join(threadsDir, f), 'utf8').split('\n')[0];
            const ev = JSON.parse(first);
            if (ev.type === 'created' && ev.body === body) return ev;
          }
          return null;
        },
        { timeout: 20_000 },
      )
      .toBeTruthy();

    const created = fs
      .readdirSync(threadsDir)
      .map((f) => JSON.parse(fs.readFileSync(path.join(threadsDir, f), 'utf8').split('\n')[0]))
      .find((ev) => ev.body === body);
    expect(created.file).toBe('src/app.ts');
    expect(created.actor.kind).toBe('human');
    expect(created.anchor.baseline.kind).toBe('commit'); // fixture repo is clean
  } finally {
    await close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
