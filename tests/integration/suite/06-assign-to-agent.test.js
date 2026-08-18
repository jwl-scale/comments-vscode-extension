'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { activateExtension, workspaceRoot, until } = require('./util');

/**
 * A fake `claude` CLI: parses the thread id out of the -p prompt, appends an
 * agent reply directly to the thread's event log (as the real agent would via
 * MCP), and emits `--output-format json` output with a session_id. Lets the
 * whole assign-to-Claude pipeline run hermetically in CI.
 */
function writeFakeClaude(root) {
  const script = path.join(root, 'fake-claude.js');
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const prompt = process.argv[process.argv.indexOf('-p') + 1];
fs.writeFileSync(path.join(process.cwd(), 'fake-claude-argv.json'), JSON.stringify(process.argv.slice(2)));
const sidIdx = process.argv.indexOf('--session-id');
const resumeIdx = process.argv.indexOf('--resume');
const sessionId =
  sidIdx !== -1 ? process.argv[sidIdx + 1] : resumeIdx !== -1 ? process.argv[resumeIdx + 1] : 'fake-fallback-session';
const threadId = (prompt.match(/th_[A-Za-z0-9-]+/) || [])[0];
const log = path.join(process.cwd(), '.comments', 'threads', threadId + '.jsonl');
const seq = fs.readFileSync(log, 'utf8').trim().split('\\n')
  .map((l) => { try { return JSON.parse(l).seq || 0; } catch { return 0; } })
  .reduce((a, b) => Math.max(a, b), 0) + 1;
// Reply stamped with actor.session, exactly as the MCP server does when
// MD_COMMENTS_SESSION is set by the runner.
fs.appendFileSync(log, JSON.stringify({
  id: 'ev_fake_' + Math.random().toString(36).slice(2),
  type: 'replied', seq, ts: new Date().toISOString(),
  actor: { name: 'claude', kind: 'agent', session: sessionId },
  commentId: 'c_fake_reply', body: 'Investigated: the constant is intentional.',
}) + '\\n');
// stream-json shape: tool-use progress events, then the terminal result.
process.stdout.write(JSON.stringify({ type: 'assistant', session_id: sessionId,
  message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'notes.md' } }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: sessionId }) + '\\n');
`,
    { mode: 0o755 },
  );
  return script;
}

describe('assign to agent (fake CLI)', () => {
  let api, root, threadId, firstSessionId;

  before(async () => {
    api = await activateExtension();
    root = workspaceRoot();
    const fake = writeFakeClaude(root);
    await vscode.workspace
      .getConfiguration('mdComments')
      .update('agent.command', fake, vscode.ConfigurationTarget.Workspace);
  });

  after(async () => {
    await vscode.workspace
      .getConfiguration('mdComments')
      .update('agent.command', undefined, vscode.ConfigurationTarget.Workspace);
  });

  it('claims, runs the agent, stamps replies with the session, and releases', async function () {
    {
      const doc = await vscode.workspace.openTextDocument(path.join(root, 'notes.md'));
      await vscode.window.showTextDocument(doc);
      const range = new vscode.Range(0, 0, 0, 5);
      api.comments.addThreadWithComment(doc, range, '@claude what is this heading for?');
      const state = await until(
        () => api.store.threadsForFile('notes.md').find((t) => t.comments[0]?.body.includes('heading')),
        5000,
        'thread created',
      );

      const result = await vscode.commands.executeCommand('mdComments.assignToAgent', {
        threadId: state.id,
      });
      assert.equal(result.ok, true, result.error);
      assert.ok(result.sessionId, 'runner pre-assigned a session id');

      const after = await until(() => {
        const t = api.store.getThread(state.id);
        return t && t.events.some((e) => e.type === 'released') ? t : null;
      }, 10000, 'run completed');

      const types = after.events.map((e) => e.type);
      assert.ok(types.includes('claimed'), 'claim lease taken');
      assert.equal(types.indexOf('claimed') < types.indexOf('released'), true, 'released after claim');

      // The agent's reply itself carries the session (actor.session) …
      const reply = after.comments.find((c) => c.body.includes('constant is intentional'));
      assert.ok(reply, 'agent reply landed');
      assert.equal(reply.session, result.sessionId, 'reply stamped with its session');
      // … so no redundant "Attached conversation" chip comment is appended.
      assert.equal(
        after.comments.some((c) => c.body.includes('Attached conversation')),
        false,
        'no redundant chip comment when replies are stamped',
      );
      threadId = state.id;
      firstSessionId = result.sessionId;
    }
  });

  it('follow-up runs stick to the thread session (continue, not fork), with ⚙ options applied', async function () {
    api.comments.replyToThreadById(
      vscode.Uri.file(path.join(root, 'notes.md')),
      threadId,
      'follow-up: and what about the second paragraph?',
    );

    const result = await vscode.commands.executeCommand('mdComments.assignToAgent', {
      threadId,
      options: { model: 'sonnet', maxTurns: 5 },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.sessionId, firstSessionId, 'same session continued across turns');

    const argv = JSON.parse(fs.readFileSync(path.join(root, 'fake-claude-argv.json'), 'utf8'));
    const flag = (name) => {
      const i = argv.indexOf(name);
      return i === -1 ? undefined : argv[i + 1];
    };
    assert.equal(flag('--resume'), firstSessionId, 'resumed the thread session');
    assert.ok(!argv.includes('--fork-session'), 'continued, not forked');
    assert.ok(!argv.includes('--session-id'), 'no fresh session id');
    assert.equal(flag('--model'), 'sonnet');
    assert.equal(flag('--max-turns'), '5');

    const after = await until(() => {
      const t = api.store.getThread(threadId);
      const stamped = t?.comments.filter((c) => c.session === firstSessionId) ?? [];
      return stamped.length >= 2 ? t : null;
    }, 10000, 'second stamped reply');
    assert.ok(after, 'both agent replies carry the same session');
  });
});

/**
 * The v0.11 → v0.12 rename is only safe if both compatibility shims hold:
 * old command ids stay dispatchable (user keybindings) and the deprecated
 * setting still resolves when the new one is empty.
 */
describe('provider-neutral rename: v0.11 compatibility', () => {
  let api, root;

  before(async () => {
    api = await activateExtension();
    root = workspaceRoot();
  });

  after(async () => {
    await vscode.workspace
      .getConfiguration('mdComments')
      .update('claudeCommand', undefined, vscode.ConfigurationTarget.Workspace);
  });

  it('keeps the old command ids registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const legacy of [
      'mdComments.assignToClaude',
      'mdComments.configureAssignToClaude',
      'mdComments.askClaudeFollowUp',
      'mdComments.attachClaudeSession',
    ]) {
      assert.ok(all.includes(legacy), `${legacy} should still be dispatchable`);
    }
    for (const current of [
      'mdComments.assignToAgent',
      'mdComments.configureAssignToAgent',
      'mdComments.askAgentFollowUp',
      'mdComments.attachAgentSession',
      'mdComments.installSkill',
    ]) {
      assert.ok(all.includes(current), `${current} should be registered`);
    }
  });

  it('still honors the deprecated claudeCommand setting', async function () {
    const fake = writeFakeClaude(root);
    await vscode.workspace
      .getConfiguration('mdComments')
      .update('claudeCommand', fake, vscode.ConfigurationTarget.Workspace);

    const doc = await vscode.workspace.openTextDocument(path.join(root, 'notes.md'));
    await vscode.window.showTextDocument(doc);
    api.comments.addThreadWithComment(doc, new vscode.Range(0, 0, 0, 5), 'legacy setting path');
    const state = await until(
      () => api.store.threadsForFile('notes.md').find((t) => t.comments[0]?.body.includes('legacy setting')),
      5000,
      'thread created',
    );

    // Dispatched through the LEGACY command id, resolving the LEGACY setting.
    const result = await vscode.commands.executeCommand('mdComments.assignToClaude', {
      threadId: state.id,
    });
    assert.equal(result.ok, true, result.error);
  });
});
