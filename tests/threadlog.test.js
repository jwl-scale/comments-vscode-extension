const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseLog, foldThread, appendEvent, readLog } = require('../out/threadLog.js');

const human = (name) => ({ name, kind: 'human' });

function ev(fields) {
  return Object.assign({ id: `ev_${Math.random().toString(36).slice(2)}`, seq: 0, ts: '2026-01-01T00:00:00.000Z', actor: human('a') }, fields);
}

test('fold: created + replies + resolve/reopen, ordered by (seq, ts, id)', () => {
  const anchor = { baseline: null, start: { line: 1, char: 0 }, end: { line: 1, char: 5 }, text: 'hello', prefix: '', suffix: '' };
  const events = [
    // Deliberately out of order, with a clock-skewed reopen: seq must win over ts.
    ev({ id: 'ev_3', type: 'resolved', seq: 3, ts: '2026-01-01T00:02:00Z', reason: 'fixed' }),
    ev({ id: 'ev_1', type: 'created', seq: 1, ts: '2026-01-01T00:00:00Z', file: 'src/a.ts', anchor, body: 'first', commentId: 'c_1' }),
    ev({ id: 'ev_4', type: 'reopened', seq: 4, ts: '2026-01-01T00:01:00Z' }), // earlier wall clock, later seq
    ev({ id: 'ev_2', type: 'replied', seq: 2, ts: '2026-01-01T00:01:30Z', body: 'second', commentId: 'c_2', actor: human('b') }),
  ];
  const state = foldThread('th_x', events);
  assert.equal(state.file, 'src/a.ts');
  assert.equal(state.status, 'open'); // reopen (seq 4) beats resolve (seq 3) despite earlier ts
  assert.deepEqual(state.comments.map((c) => c.body), ['first', 'second']);
  assert.equal(state.comments[1].author, 'b');
});

test('fold: edits keep history flags, deletes tombstone, unknown events ignored', () => {
  const anchor = { baseline: null, start: { line: 0, char: 0 }, end: { line: 0, char: 1 }, text: 'x', prefix: '', suffix: '' };
  const state = foldThread('th_x', [
    ev({ type: 'created', seq: 1, file: 'f', anchor, body: 'v1', commentId: 'c_1' }),
    ev({ type: 'replied', seq: 2, body: 'reply', commentId: 'c_2' }),
    ev({ type: 'edited', seq: 3, commentId: 'c_1', body: 'v2' }),
    ev({ type: 'comment_deleted', seq: 4, commentId: 'c_2' }),
    ev({ type: 'from_the_future', seq: 5, whatever: true }),
    ev({ type: 'severity_changed', seq: 6, severity: 'blocking' }),
  ]);
  assert.equal(state.comments[0].body, 'v2');
  assert.equal(state.comments[0].edited, true);
  assert.equal(state.comments[1].deleted, true);
  assert.equal(state.severity, 'blocking');
});

test('parseLog: skips torn tail, dedupes union-merge duplicates', () => {
  const line = JSON.stringify(ev({ id: 'ev_dup', type: 'created', seq: 1, file: 'f', anchor: {}, body: 'x', commentId: 'c_1' }));
  const text = line + '\n' + line + '\n' + '{"id":"ev_torn","type":"repl'; // duplicate + torn tail
  const events = parseLog(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'ev_dup');
});

test('appendEvent: locked appends produce strictly increasing seq and clean up locks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-log-'));
  const file = path.join(dir, 'threads', 'th_a.jsonl');
  try {
    appendEvent(file, human('u'), 'created', { file: 'f', anchor: {}, body: 'one', commentId: 'c_1' });
    appendEvent(file, human('u'), 'replied', { body: 'two', commentId: 'c_2' });
    appendEvent(file, human('u'), 'resolved', { reason: 'fixed' });
    const events = readLog(file);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
    assert.equal(fs.existsSync(file + '.lock'), false);
    const state = foldThread('th_a', events);
    assert.equal(state.status, 'resolved');
    assert.equal(state.resolveReason, 'fixed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fold: renamed and reanchored update derived file/anchor', () => {
  const anchor = { baseline: null, start: { line: 3, char: 0 }, end: { line: 3, char: 4 }, text: 'code', prefix: '', suffix: '' };
  const moved = { baseline: { kind: 'commit', sha: 'abc' }, start: { line: 9, char: 0 }, end: { line: 9, char: 4 }, text: 'code', prefix: '', suffix: '' };
  const state = foldThread('th_x', [
    ev({ type: 'created', seq: 1, file: 'old.ts', anchor, body: 'x', commentId: 'c_1' }),
    ev({ type: 'renamed', seq: 2, file: 'new.ts' }),
    ev({ type: 'reanchored', seq: 3, anchor: moved, method: 'diff' }),
  ]);
  assert.equal(state.file, 'new.ts');
  assert.equal(state.anchor.start.line, 9);
  assert.equal(state.reanchorMethod, 'diff');
});

const { liveClaim } = require('../out/threadLog.js');

test('fold: claims lease and release; liveClaim honors TTL', () => {
  const anchor = { baseline: null, start: { line: 0, char: 0 }, end: { line: 0, char: 1 }, text: 'x', prefix: '', suffix: '' };
  const base = [
    ev({ type: 'created', seq: 1, file: 'f', anchor, body: 'x', commentId: 'c_1' }),
    ev({ type: 'claimed', seq: 2, ts: '2026-01-01T00:00:00.000Z', ttlSeconds: 3600, actor: { name: 'fixer', kind: 'agent' } }),
  ];
  const claimed = foldThread('th_x', base);
  assert.equal(claimed.claim.actor.name, 'fixer');
  assert.ok(liveClaim(claimed, new Date('2026-01-01T00:30:00Z')), 'live within TTL');
  assert.equal(liveClaim(claimed, new Date('2026-01-01T02:00:00Z')), undefined, 'expired after TTL');

  const released = foldThread('th_x', [
    ...base,
    ev({ type: 'released', seq: 3, actor: { name: 'fixer', kind: 'agent' } }),
  ]);
  assert.equal(released.claim, undefined);
});

test('fold: suggestions accumulate with accept/reject status', () => {
  const anchor = { baseline: null, start: { line: 0, char: 0 }, end: { line: 0, char: 1 }, text: 'x', prefix: '', suffix: '' };
  const state = foldThread('th_x', [
    ev({ type: 'created', seq: 1, file: 'f', anchor, body: 'x', commentId: 'c_1' }),
    ev({ type: 'suggested', seq: 2, suggestionId: 's_1', patch: '--- a/f\n+++ b/f\n', actor: { name: 'claude', kind: 'agent' } }),
    ev({ type: 'suggested', seq: 3, suggestionId: 's_2', patch: '--- a/g\n+++ b/g\n', actor: { name: 'claude', kind: 'agent' } }),
    ev({ type: 'suggestion_rejected', seq: 4, suggestionId: 's_1' }),
    ev({ type: 'suggestion_accepted', seq: 5, suggestionId: 's_2' }),
  ]);
  assert.deepEqual(state.suggestions.map((s) => [s.id, s.status]), [['s_1', 'rejected'], ['s_2', 'accepted']]);
});
