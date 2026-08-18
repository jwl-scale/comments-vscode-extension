'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { activateExtension, workspaceRoot, until } = require('./util');

describe('v1 → v2 migration', () => {
  it('migrates a v1 mirrored-tree sidecar into an event log, preserving the id', async () => {
    const api = await activateExtension();
    const root = workspaceRoot();

    const v1Dir = path.join(root, '.comments', 'src');
    fs.mkdirSync(v1Dir, { recursive: true });
    const legacyContent = fs.readFileSync(path.join(root, 'src', 'legacy.ts'), 'utf8');
    const target = 'LEGACY = true';
    const idx = legacyContent.indexOf(target);
    fs.writeFileSync(
      path.join(v1Dir, 'legacy.ts.json'),
      JSON.stringify({
        version: 1,
        file: 'src/legacy.ts',
        threads: [
          {
            id: 'aaaa1111-2222-3333-4444-555566667777',
            status: 'resolved',
            anchor: {
              startLine: 0,
              endLine: 0,
              startChar: idx,
              endChar: idx + target.length,
              text: target,
              prefix: legacyContent.slice(0, idx),
              suffix: legacyContent.slice(idx + target.length),
            },
            comments: [
              { id: 'c-1', author: 'alice', body: 'flip this flag', createdAt: '2026-07-01T00:00:00.000Z' },
              { id: 'c-2', author: 'bob', body: 'done', createdAt: '2026-07-02T00:00:00.000Z' },
            ],
          },
        ],
      }),
    );

    assert.equal(api.store.hasV1Sidecars(), true);
    await vscode.commands.executeCommand('mdComments.migrateSidecars');

    const state = await until(
      () => api.store.getThread('th_aaaa1111-2222-3333-4444-555566667777'),
      5000,
      'migrated thread',
    );
    assert.equal(state.file, 'src/legacy.ts');
    assert.equal(state.status, 'resolved');
    assert.equal(state.resolveReason, 'unknown', 'historic reason is unrecoverable');
    assert.deepEqual(state.comments.map((c) => [c.author, c.body]), [['alice', 'flip this flag'], ['bob', 'done']]);
    assert.equal(state.comments[0].createdAt, '2026-07-01T00:00:00.000Z', 'original timestamps preserved');
    assert.equal(state.anchor.text, target);
    assert.equal(state.anchor.baseline.kind, 'commit', 'clean file re-baselined to HEAD');

    assert.equal(fs.existsSync(path.join(v1Dir, 'legacy.ts.json')), false, 'v1 sidecar deleted');
    assert.equal(fs.existsSync(v1Dir), false, 'empty mirrored dir cleaned up');
    assert.equal(api.store.hasV1Sidecars(), false);
  });
});
