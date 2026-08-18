'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');
const { activateExtension, workspaceRoot, until } = require('./util');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('git-baselined anchoring', () => {
  let api, root;

  before(async () => {
    api = await activateExtension();
    root = workspaceRoot();
  });

  it('re-baselines to the new HEAD after a commit moves the anchor', async function () {
    const rel = 'src/rebase.ts';
    const abs = path.join(root, rel);
    let doc = await vscode.workspace.openTextDocument(abs);
    await vscode.window.showTextDocument(doc);

    const target = 'let delay = 100;';
    const offset = doc.getText().indexOf(target);
    const range = new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + target.length));
    api.comments.addThreadWithComment(doc, range, 'delay should be configurable');
    const state = await until(
      () => api.store.threadsForFile(rel).find((t) => t.comments[0]?.body.startsWith('delay should')),
      5000,
      'thread created',
    );
    const shaA = state.anchor.baseline.sha;
    const lineA = state.anchor.start.line;
    assert.equal(state.anchor.baseline.kind, 'commit');
    assert.equal(shaA, git(root, 'rev-parse', 'HEAD'));

    // Edit ABOVE the anchor (through the live buffer, like a user) and commit —
    // the anchor must shift down.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 0), '// prepended A\n// prepended B\n');
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    git(root, 'add', rel);
    git(root, 'commit', '-qm', 'prepend two lines');
    const shaB = git(root, 'rev-parse', 'HEAD');

    // Reload: resolution translates via diff from baseline A, then lazily
    // re-baselines to HEAD B (buffer byte-matches the new HEAD blob).
    api.comments.reloadFromDisk(doc.uri);

    const rebaselined = await until(() => {
      const t = api.store.getThread(state.id);
      return t && t.anchor.baseline.sha === shaB ? t : null;
    }, 10000, 'reanchored event with new HEAD');
    assert.equal(rebaselined.anchor.start.line, lineA + 2, 'anchor shifted by the prepended lines');
    assert.equal(rebaselined.anchor.text, target, 'anchored text unchanged');
    assert.equal(rebaselined.reanchorMethod, 'diff');
    const reanchor = rebaselined.events.find((e) => e.type === 'reanchored');
    assert.ok(reanchor, 'explicit reanchored event persisted');
  });

  it('records renames as events on affected threads', async function () {
    const oldUri = vscode.Uri.file(path.join(root, 'src', 'rebase.ts'));
    const newUri = vscode.Uri.file(path.join(root, 'src', 'backoff.ts'));
    // onDidRenameFiles only fires for user gestures / applyEdit — not fs.rename.
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(oldUri, newUri);
    await vscode.workspace.applyEdit(edit);

    const state = await until(() => {
      const threads = api.store.threadsForFile('src/backoff.ts');
      return threads.length > 0 ? threads[0] : null;
    }, 10000, 'thread follows rename');
    assert.ok(state.events.some((e) => e.type === 'renamed' && e.file === 'src/backoff.ts'));
    assert.equal(api.store.threadsForFile('src/rebase.ts').length, 0);
  });
});
