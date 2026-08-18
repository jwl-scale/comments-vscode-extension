'use strict';
const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { activateExtension, workspaceRoot, until } = require('./util');

describe('thread cross-references', () => {
  it('copies thread/comment refs and openThread reveals the target thread', async function () {
    const api = await activateExtension();
    const root = workspaceRoot();

    // Thread A on notes.md (created in earlier suites or fresh here).
    const notes = await vscode.workspace.openTextDocument(path.join(root, 'notes.md'));
    api.comments.addThreadWithComment(notes, new vscode.Range(2, 0, 2, 10), 'jitter discussion (target)');
    const threadA = await until(
      () => api.store.threadsForFile('notes.md').find((t) => t.comments[0]?.body.includes('(target)')),
      5000,
      'thread A',
    );

    // Thread B on src/app.ts referencing A and A's first comment.
    const app = await vscode.workspace.openTextDocument(path.join(root, 'src', 'app.ts'));
    api.comments.addThreadWithComment(
      app,
      new vscode.Range(0, 0, 0, 8),
      `see thread:${threadA.id} and specifically thread:${threadA.id}#${threadA.comments[0].id}`,
    );
    const threadB = await until(
      () => api.store.threadsForFile('src/app.ts').find((t) => t.comments[0]?.body.includes('see thread:')),
      5000,
      'thread B',
    );
    assert.ok(threadB, 'referencing thread persisted');

    // Copy commands produce canonical refs.
    await vscode.commands.executeCommand('mdComments.copyThreadRef', { threadId: threadA.id });
    assert.equal(await vscode.env.clipboard.readText(), `thread:${threadA.id}`);

    // openThread navigates to the target thread's file and anchor.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('mdComments.openThread', threadA.id, threadA.comments[0].id);
    await until(
      () => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('notes.md'),
      10000,
      'editor revealed target file',
    );
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor.selection.start.line, threadA.anchor.start.line, 'revealed at the anchor');
  });
});
