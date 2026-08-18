'use strict';
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');
const { activateExtension, workspaceRoot, until, TIMEOUT_SCALE } = require('./util');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('accept & land (extension → notary CLI)', () => {
  it('lands an open suggestion as a stamped commit pair without touching the working tree', async function () {
    this.timeout(60000 * TIMEOUT_SCALE);
    const api = await activateExtension();
    const root = workspaceRoot();

    const doc = await vscode.workspace.openTextDocument(path.join(root, 'src', 'app.ts'));
    api.comments.addThreadWithComment(doc, new vscode.Range(2, 2, 2, 12), 'audit this constant');
    const state = await until(
      () => api.store.threadsForFile('src/app.ts').find((t) => t.comments[0]?.body.includes('audit this')),
      5000,
      'thread created',
    );

    const patch = [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,4 +1,4 @@',
      ' function main() {',
      '   const x = compute();',
      '-  return 42;',
      '+  return 42; // audited',
      ' }',
      '',
    ].join('\n');
    api.store.append(state.id, { name: 'claude', kind: 'agent' }, 'suggested', {
      suggestionId: 's_landme',
      patch,
      baseline: null,
    });

    const report = await vscode.commands.executeCommand('mdComments.acceptAndLand', { threadId: state.id });
    assert.ok(report, 'CLI produced a report');
    assert.equal(report.ok, true, JSON.stringify(report));

    // Stamped commit pair on the target branch.
    assert.match(git(root, 'log', '-1', '--format=%B'), /Comments-Meta-For:/);
    const codeMsg = git(root, 'log', '-1', '--skip=1', '--format=%B');
    assert.match(codeMsg, new RegExp(`Comments-Resolves: ${state.id}`));
    assert.match(git(root, 'show', 'HEAD~1:src/app.ts'), /audited/);

    // Thread advanced atomically with the code.
    const after = await until(() => {
      const t = api.store.getThread(state.id);
      return t && t.status === 'resolved' ? t : null;
    }, 10000, 'thread resolved by landing');
    assert.equal(after.resolveReason, 'fixed');
    assert.equal(after.suggestions.find((s) => s.id === 's_landme').status, 'accepted');
  });
});
