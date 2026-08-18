'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { activateExtension, workspaceRoot, until } = require('./util');

describe('thread lifecycle (extension host)', () => {
  let api, root, doc, threadId;

  before(async () => {
    api = await activateExtension();
    root = workspaceRoot();
    doc = await vscode.workspace.openTextDocument(path.join(root, 'src', 'app.ts'));
    await vscode.window.showTextDocument(doc);
  });

  it('creates a thread with a commit baseline on a clean file', async () => {
    const target = 'return 42;';
    const offset = doc.getText().indexOf(target);
    const range = new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + target.length));
    api.comments.addThreadWithComment(doc, range, 'why 42? see notes.md:1');

    const state = await until(
      () => api.store.threadsForFile('src/app.ts').find((t) => t.comments[0]?.body.startsWith('why 42?')),
      5000,
      'thread in store',
    );
    threadId = state.id;
    assert.match(threadId, /^th_[A-Za-z0-9-]+$/);
    assert.equal(state.anchor.text, target);
    assert.equal(state.anchor.baseline.kind, 'commit', 'clean committed file → commit baseline');
    assert.equal(state.severity, 'normal');

    const logPath = path.join(root, '.comments', 'threads', `${threadId}.jsonl`);
    const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events[0].type, 'created');
    assert.equal(events[0].seq, 1);
    assert.equal(events[0].actor.kind, 'human');
  });

  it('wrote the union-merge gitattributes line', () => {
    const ga = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
    assert.ok(ga.includes('.comments/threads/*.jsonl merge=union'));
  });

  it('reply, resolve, and reopen append attributed events', async () => {
    api.comments.replyToThreadById(doc.uri, threadId, 'because the spec says so');
    api.comments.setThreadStatusById(doc.uri, threadId, 'resolved');

    let state = await until(
      () => {
        const t = api.store.getThread(threadId);
        return t && t.status === 'resolved' && t.comments.length === 2 ? t : null;
      },
      5000,
      'resolved with reply',
    );
    assert.equal(state.resolveReason, 'fixed');
    assert.equal(state.comments[1].body, 'because the spec says so');

    api.comments.setThreadStatusById(doc.uri, threadId, 'open');
    state = await until(() => {
      const t = api.store.getThread(threadId);
      return t && t.status === 'open' ? t : null;
    }, 5000, 'reopened');
    const types = state.events.map((e) => e.type);
    assert.deepEqual(types, ['created', 'replied', 'resolved', 'reopened']);
    assert.deepEqual(state.events.map((e) => e.seq), [1, 2, 3, 4]);
  });

  it('lists the thread in the repo-wide view model', () => {
    const byFile = api.store.listByFile();
    const entry = byFile.find((e) => e.file === 'src/app.ts');
    assert.ok(entry, 'file group present');
    assert.ok(entry.threads.some((t) => t.id === threadId));
  });
});
