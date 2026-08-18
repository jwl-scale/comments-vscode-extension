'use strict';
const assert = require('assert');
const vscode = require('vscode');
const { activateExtension, TIMEOUT_SCALE } = require('./util');

describe('MCP doctor', () => {
  it('verifies the bundled server end-to-end and reports structured diagnostics', async function () {
    this.timeout(60000 * TIMEOUT_SCALE); // `claude mcp list` pings every configured server
    await activateExtension();
    const diag = await vscode.commands.executeCommand('mdComments.verifyMcpSetup');
    assert.ok(diag, 'command returns diagnostics');
    assert.equal(diag.serverExists, true, diag.messages.join('\n'));
    assert.equal(diag.serverResponds, true, diag.messages.join('\n'));
    assert.equal(diag.toolCount, 14);
    // Registration state depends on the machine (claude CLI may be absent or
    // registered against an installed copy) — assert only that it's classified.
    assert.ok(['ok', 'missing', 'stale-path', 'unknown'].includes(diag.registration));
  });
});
