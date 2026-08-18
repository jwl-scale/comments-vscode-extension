'use strict';
const vscode = require('vscode');

async function activateExtension() {
  const ext = vscode.extensions.getExtension('jonathan-lee.anchored-comments');
  if (!ext) throw new Error('extension jonathan-lee.anchored-comments not found in test host');
  return ext.activate(); // MdCommentsApi: { store, comments }
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders[0].uri.fsPath;
}

/**
 * Poll until fn() is truthy (returning its value) or time out.
 *
 * Every caller is asserting EVENTUAL behaviour (a watcher fires, a widget
 * renders), so the budget is about runner speed, not correctness. A cold CI
 * runner under xvfb is several times slower than a warm laptop, so scale the
 * budget there rather than hardcoding a number that is either flaky in CI or
 * needlessly slow locally.
 */
const TIMEOUT_SCALE = process.env.CI ? 4 : 1;

async function until(fn, ms = 10000, label = 'condition') {
  ms *= TIMEOUT_SCALE;
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

module.exports = { activateExtension, workspaceRoot, until, TIMEOUT_SCALE };
