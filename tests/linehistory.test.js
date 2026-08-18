const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { lineHistory, blameLine, parseTrailers, threadsOnFileAt, readBrief } = require('../out/lineHistory.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('parseTrailers extracts the full trailer grammar', () => {
  const t = parseTrailers(
    'fix: thing\n\nbody\n\nComments-Resolves: th_a\nComments-Thread: th_b\nClaude-Session: sid#u1..u2\nProvenance: agent\n',
  );
  assert.deepEqual(t.resolves, ['th_a']);
  assert.deepEqual(t.threads, ['th_b']);
  assert.equal(t.session, 'sid#u1..u2');
  assert.equal(t.provenance, 'agent');
});

test('lineHistory + blameLine join ancestry with trailers, threads-at-commit, and briefs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-lh-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@t');
    git(root, 'config', 'user.name', 't');
    git(root, 'config', 'commit.gpgsign', 'false');

    // Commit 1: the file plus a thread anchored to its second line.
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'function f() {\n  return 1;\n}\n');
    fs.mkdirSync(path.join(root, '.comments', 'threads'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.comments', 'threads', 'th_hist.jsonl'),
      JSON.stringify({
        id: 'ev_1', type: 'created', seq: 1, ts: '2026-08-01T00:00:00Z',
        actor: { name: 'jon', kind: 'human' }, version: 2, file: 'src/a.ts',
        anchor: { baseline: null, start: { line: 1, char: 2 }, end: { line: 1, char: 11 }, text: 'return 1;', prefix: '', suffix: '' },
        body: 'why one?', commentId: 'c_1',
      }) + '\n',
    );
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    const sha1 = git(root, 'rev-parse', 'HEAD');

    // Commit 2: a stamped landing touches the anchored line; brief in commit 3.
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'function f() {\n  return answer();\n}\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'fix: use answer()\n\nComments-Resolves: th_hist\nClaude-Session: sess-h#u1..u2\nProvenance: agent');
    const sha2 = git(root, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.join(root, '.comments', 'briefs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.comments', 'briefs', `${sha2}.md`), '# brief\n- provenance: agent\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', `comments: metadata\n\nComments-Meta-For: ${sha2}`);

    const entries = lineHistory(root, 'src/a.ts', 2, 2);
    assert.equal(entries.length, 2, JSON.stringify(entries.map((e) => e.subject)));
    assert.equal(entries[0].sha, sha2, 'newest first');
    assert.deepEqual(entries[0].trailers.resolves, ['th_hist']);
    assert.equal(entries[0].trailers.provenance, 'agent');
    assert.ok(entries[0].briefPath, 'brief located from the metadata commit');
    assert.match(readBrief(root, entries[0].briefPath), /provenance: agent/);
    assert.equal(entries[1].sha, sha1);
    // At commit 1, the thread was anchored to this file with exact positions.
    assert.deepEqual(entries[1].threadsAtCommit, [
      { threadId: 'th_hist', status: 'open', startLine: 2, firstComment: 'why one?' },
    ]);

    const blame = blameLine(root, 'src/a.ts', 2);
    assert.equal(blame.sha, sha2);
    assert.deepEqual(blame.trailers.resolves, ['th_hist']);

    assert.deepEqual(threadsOnFileAt(root, sha2, 'src/other.ts'), [], 'file filter holds');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
