'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { activateExtension } = require('./util');

/**
 * Cursor support running in a real extension host.
 *
 * These tests run INSIDE the extension host process, so setting the fixture
 * env var here is visible to the extension's own path resolution — which is
 * the whole reason MD_COMMENTS_CURSOR_HOME exists.
 */
describe('cursor provider (extension host)', () => {
  const SESSION_ID = '44444444-4444-4444-8444-444444444444';
  let home;
  let prevHome;

  before(async () => {
    await activateExtension();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-cursor-int-'));
    const dir = path.join(home, 'projects', 'Users-me-repo', 'agent-transcripts', SESSION_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${SESSION_ID}.jsonl`),
      [
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: '<user_query>\nwhy is this 42\n</user_query>' }] },
        }),
        JSON.stringify({
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'because' },
              { type: 'tool_use', name: 'Read', input: { path: '/repo/src/app.ts' } },
            ],
          },
        }),
      ].join('\n') + '\n',
    );
    prevHome = process.env.MD_COMMENTS_CURSOR_HOME;
    process.env.MD_COMMENTS_CURSOR_HOME = home;
  });

  after(() => {
    if (prevHome === undefined) delete process.env.MD_COMMENTS_CURSOR_HOME;
    else process.env.MD_COMMENTS_CURSOR_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('registers the cursor commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ['mdComments.cursorChatRef', 'mdComments.openCursorChat']) {
      assert.ok(all.includes(id), `${id} should be registered`);
    }
  });

  it('discovers a cursor transcript and renders it as a conversation graph', async () => {
    const { findLocalSessions, loadSessionGraph, vendorSession } = require('../../../out/sessions.js');

    const found = findLocalSessions(1000).find((s) => s.sessionId === SESSION_ID);
    assert.ok(found, 'cursor session should be discovered');
    assert.equal(found.scheme, 'cursor');
    // The prompt is unwrapped from Cursor's <user_query> scaffolding.
    assert.match(found.preview, /why is this 42/);

    // Vendoring is what makes a conversation survive in a clone, and the graph
    // must load from the vendored copy with the scheme recovered by sniffing.
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-vend-'));
    try {
      vendorSession(found, sessionsDir);
      const graph = loadSessionGraph(sessionsDir, SESSION_ID);
      assert.ok(graph, 'vendored cursor transcript should load');
      assert.equal(graph.scheme, 'cursor', 'graph must carry its provider for ref building');
      assert.deepEqual(graph.messages.map((m) => m.uuid), ['m0', 'm1']);
      assert.equal(graph.messages[1].toolUses[0].name, 'Read');
    } finally {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('openCursorChat degrades with a warning outside Cursor instead of throwing', async () => {
    // The integration host is VS Code, where composer.openComposer does not
    // exist. The command must explain that rather than fail — this is the path
    // every non-Cursor user hits.
    const all = await vscode.commands.getCommands(true);
    assert.ok(!all.includes('composer.openComposer'), 'sanity: host is not Cursor');
    await vscode.commands.executeCommand('mdComments.openCursorChat', SESSION_ID);
  });
});
