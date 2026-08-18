'use strict';
/** Launch desktop VS Code under Playwright with the extension in dev mode. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('@playwright/test');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function launchVSCode(workspace) {
  const executablePath = await downloadAndUnzipVSCode(); // cached in .vscode-test/
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-ui-ud-'));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-ui-ext-'));
  const app = await _electron.launch({
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-extensions',
      `--extensionDevelopmentPath=${REPO_ROOT}`,
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      workspace,
    ],
  });
  const window = await app.firstWindow();
  await window.waitForSelector('.monaco-workbench', { timeout: 60_000 });
  const close = async () => {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(extensionsDir, { recursive: true, force: true });
  };
  return { app, window, close };
}

/** Quick Open (mod+P) → open a file by name. */
async function openFile(window, fileName) {
  await window.keyboard.press(`${MOD}+P`);
  await window.waitForSelector('.quick-input-widget:not(.hidden)');
  await window.keyboard.type(fileName, { delay: 20 });
  await window.waitForTimeout(400); // let the picker filter
  await window.keyboard.press('Enter');
  await window.waitForSelector('.editor-instance .monaco-editor', { timeout: 15_000 });
  await window.waitForTimeout(400); // editor focus settles
}

/** Command Palette (F1) → run a command by its title. */
async function runCommand(window, title) {
  await window.keyboard.press('F1');
  await window.waitForSelector('.quick-input-widget:not(.hidden)');
  await window.keyboard.type(title, { delay: 20 });
  await window.waitForTimeout(400);
  await window.keyboard.press('Enter');
}

/** The active webview's content frame (VS Code nests: iframe.webview → #active-frame). */
function webviewFrame(window) {
  return window.frameLocator('iframe.webview.ready').last().frameLocator('#active-frame');
}

module.exports = { launchVSCode, openFile, runCommand, webviewFrame, MOD };
