'use strict';
/**
 * Tier-2 launcher: downloads VS Code (cached in .vscode-test/), opens a
 * hermetic git-repo workspace, and runs tests/integration/suite/ INSIDE the
 * extension host, against the bundled extension (dist/extension.js — the
 * artifact that ships). Run with `npm run test:integration`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');
const { buildBaseFixture } = require('./fixture');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const workspace = buildBaseFixture();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-ud-'));
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${userDataDir}`,
      ],
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('integration tests failed:', err);
  process.exit(1);
});
