'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { activateExtension, workspaceRoot, until } = require('./util');

describe('suggestion mode', () => {
  it('accepting a suggested patch applies it to the working tree and records the event', async function () {
    const api = await activateExtension();
    const root = workspaceRoot();

    const doc = await vscode.workspace.openTextDocument(path.join(root, 'src', 'legacy.ts'));
    api.comments.addThreadWithComment(doc, new vscode.Range(0, 0, 0, 10), 'flag should be off by default');
    const state = await until(
      () => api.store.threadsForFile('src/legacy.ts').find((t) => t.comments[0]?.body.includes('flag should')),
      5000,
      'thread created',
    );

    const patch = [
      '--- a/src/legacy.ts',
      '+++ b/src/legacy.ts',
      '@@ -1 +1 @@',
      '-export const LEGACY = true;',
      '+export const LEGACY = false;',
      '',
    ].join('\n');
    api.store.append(state.id, { name: 'claude', kind: 'agent' }, 'suggested', {
      suggestionId: 's_test_1',
      patch,
      baseline: null,
    });

    const withSuggestion = await until(() => {
      const t = api.store.getThread(state.id);
      return t && t.suggestions.length === 1 ? t : null;
    }, 5000, 'suggestion visible');
    assert.equal(withSuggestion.suggestions[0].status, 'open');

    await vscode.commands.executeCommand('mdComments.acceptSuggestion', { threadId: state.id });

    assert.equal(
      fs.readFileSync(path.join(root, 'src', 'legacy.ts'), 'utf8').includes('LEGACY = false'),
      true,
      'patch applied to working tree',
    );
    const after = api.store.getThread(state.id);
    assert.equal(after.suggestions[0].status, 'accepted');
    assert.ok(after.events.some((e) => e.type === 'suggestion_accepted' && e.actor.kind === 'human'));
  });

  it('rejecting a suggestion records the event without touching files', async function () {
    const api = await activateExtension();
    const root = workspaceRoot();
    const state = api.store.threadsForFile('src/legacy.ts')[0];

    api.store.append(state.id, { name: 'claude', kind: 'agent' }, 'suggested', {
      suggestionId: 's_test_2',
      patch: '--- a/src/legacy.ts\n+++ b/src/legacy.ts\n@@ -1 +1 @@\n-export const LEGACY = false;\n+export const LEGACY = 0;\n',
      baseline: null,
    });
    const before = fs.readFileSync(path.join(root, 'src', 'legacy.ts'), 'utf8');
    await vscode.commands.executeCommand('mdComments.rejectSuggestion', { threadId: state.id });

    assert.equal(fs.readFileSync(path.join(root, 'src', 'legacy.ts'), 'utf8'), before, 'file untouched');
    const after = api.store.getThread(state.id);
    assert.equal(after.suggestions.find((s) => s.id === 's_test_2').status, 'rejected');
  });
});
