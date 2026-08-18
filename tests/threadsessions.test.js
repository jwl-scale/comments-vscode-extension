const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectThreadSessions } = require('../out/threadSessions.js');
const { findReplyFocusUuid, findReplySegment } = require('../out/sessions.js');

function state(comments, events) {
  return { comments, events: events ?? [], id: 'th_x', file: 'f', status: 'open' };
}

test('collectThreadSessions: provenance, references, and the current session are distinguished', () => {
  const s = state(
    [
      { id: 'c1', author: 'jon', body: 'why is this like that? see claude:ref-session#m42', createdAt: '2026-08-01T00:00:00Z', deleted: false },
      { id: 'c2', author: 'claude', body: 'because X', createdAt: '2026-08-01T01:00:00Z', deleted: false, session: 'sess-old' },
      { id: 'c3', author: 'claude', body: 'and Y', createdAt: '2026-08-01T02:00:00Z', deleted: false, session: 'sess-new' },
    ],
    [
      { actor: { session: 'sess-old' } },
      { actor: { session: 'sess-new' } }, // latest → current
    ],
  );
  const sessions = collectThreadSessions(s);
  assert.deepEqual(sessions.map((x) => x.sessionId), ['sess-new', 'sess-old', 'ref-session']);

  const current = sessions[0];
  assert.equal(current.isCurrent, true);
  assert.equal(current.comments.length, 1);

  const old = sessions[1];
  assert.equal(old.isCurrent, false);
  assert.equal(old.comments[0].body, 'because X');

  const ref = sessions[2];
  assert.equal(ref.comments.length, 0);
  assert.deepEqual(ref.refs[0].focus, { kind: 'msg', uuid: 'm42' });
});

test('collectThreadSessions: deleted comments are ignored; no sessions → empty', () => {
  const s = state([
    { id: 'c1', author: 'claude', body: 'gone', createdAt: '2026-08-01T00:00:00Z', deleted: true, session: 'sess-x' },
    { id: 'c2', author: 'jon', body: 'plain text only', createdAt: '2026-08-01T00:00:00Z', deleted: false },
  ]);
  assert.deepEqual(collectThreadSessions(s), []);
});

test('findReplySegment: each reply owns the span since the previous comments-MCP write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-sess-'));
  try {
    const lines = [
      { uuid: 'u1', message: { content: [{ type: 'text', text: 'reading the code' }] } },
      { uuid: 'u2', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] } },
      { uuid: 'u3', message: { content: [{ type: 'tool_use', name: 'mcp__comments__reply_to_thread', input: { threadId: 'th_x', body: 'because X' } }] } },
      { uuid: 'u4', message: { content: [{ type: 'text', text: 'follow-up thinking' }] } },
      { uuid: 'u5', message: { content: [{ type: 'tool_use', name: 'mcp__comments__reply_to_thread', input: { threadId: 'th_x', body: 'and also Y' } }] } },
    ];
    fs.writeFileSync(path.join(dir, 'sess-old.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    // First reply's segment: session start → its write.
    assert.deepEqual(findReplySegment(dir, 'sess-old', 'because X'), { from: 'u1', to: 'u3' });
    // Second reply's segment starts AFTER the first write.
    assert.deepEqual(findReplySegment(dir, 'sess-old', 'and also Y'), { from: 'u4', to: 'u5' });
    // Focus helper returns the write itself.
    assert.equal(findReplyFocusUuid(dir, 'sess-old', 'and also Y'), 'u5');
    assert.equal(findReplySegment(dir, 'sess-old', 'never written'), undefined);
    assert.equal(findReplySegment(dir, 'missing-session', 'because X'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectThreadSessions: providers are distinct identities, not merged ids', () => {
  // claude:abc and cursor:abc are different conversations. Keying by bare id
  // would silently merge them and attribute comments to the wrong agent.
  const state = {
    comments: [
      { id: 'c_1', author: 'human', body: 'why?', createdAt: '2026-08-18T00:00:00Z' },
      { id: 'c_2', author: 'claude', body: 'because', createdAt: '2026-08-18T00:01:00Z', session: 'claude:abc' },
      { id: 'c_3', author: 'cursor', body: 'also', createdAt: '2026-08-18T00:02:00Z', session: 'cursor:abc' },
      // A pre-v0.12 bare ref means claude, and must fold into the claude entry.
      { id: 'c_4', author: 'claude', body: 'more', createdAt: '2026-08-18T00:03:00Z', session: 'abc' },
      { id: 'c_5', author: 'human', body: 'see cursor:xyz#m4', createdAt: '2026-08-18T00:04:00Z' },
    ],
    events: [],
  };

  const infos = collectThreadSessions(state);
  const key = (i) => `${i.scheme}:${i.sessionId}`;
  const byKey = new Map(infos.map((i) => [key(i), i]));

  assert.deepEqual([...byKey.keys()].sort(), ['claude:abc', 'cursor:abc', 'cursor:xyz']);
  assert.equal(byKey.get('claude:abc').comments.length, 2, 'bare ref folds into claude');
  assert.equal(byKey.get('cursor:abc').comments.length, 1);
  // A ref typed into a body is a reference, not provenance.
  assert.equal(byKey.get('cursor:xyz').comments.length, 0);
  assert.deepEqual(byKey.get('cursor:xyz').refs[0].focus, { kind: 'msg', uuid: 'm4' });
});
