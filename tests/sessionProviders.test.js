const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The notary/MCP side (plain JS, node-only) and the extension side (compiled).
const providers = require('../bin/lib/session-providers.js');
const { loadCodexGraph, sniffScheme, codexSessionIdFromName } = require('../out/sessionProviders.js');
const { parseSessionRef, formatSessionRef } = require('../out/refs.js');

/** Drop undefined-valued keys so refs compare on what they actually carry. */
function defined(obj) {
  if (!obj) return obj;
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function tmpdir(prefix = 'mdc-prov-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJsonl(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// ---------- ref grammar ----------

test('session refs: bare means claude, schemes round-trip, unknown schemes rejected', () => {
  // Both implementations must agree — they are a deliberate mirror.
  for (const parse of [providers.parseSessionRef, parseSessionRef]) {
    assert.deepEqual(defined(parse('abc123')), { scheme: 'claude', sessionId: 'abc123' });
    assert.deepEqual(defined(parse('claude:abc#m1..m9')), {
      scheme: 'claude',
      sessionId: 'abc',
      msgUuid: 'm1',
      rangeEnd: 'm9',
    });
    assert.deepEqual(defined(parse('codex:019f-dd')), { scheme: 'codex', sessionId: '019f-dd' });
    assert.deepEqual(defined(parse('claude:abc@sub1')), {
      scheme: 'claude',
      sessionId: 'abc',
      agentId: 'sub1',
    });

    // A provider must never guess at another's id space.
    assert.equal(parse('gemini:abc'), null);
    assert.equal(parse('not a ref'), null);
  }
});

test('session refs: writers always emit the scheme', () => {
  for (const fmt of [providers.formatSessionRef, formatSessionRef]) {
    assert.equal(fmt({ scheme: 'claude', sessionId: 's1' }), 'claude:s1');
    assert.equal(fmt({ scheme: 'codex', sessionId: 's1', msgUuid: 'a', rangeEnd: 'b' }), 'codex:s1#a..b');
    assert.equal(fmt({ scheme: 'codex', sessionId: 's1', agentId: 'w2' }), 'codex:s1@w2');
    // A range needs both ends; a lone msgUuid stays a single-message ref.
    assert.equal(fmt({ scheme: 'claude', sessionId: 's1', msgUuid: 'a' }), 'claude:s1#a');
  }
});

// ---------- worktree path mapping ----------

test('mapToRoot: relativizes, maps worktree paths by unique suffix, refuses ambiguity', () => {
  const root = '/repo';
  assert.equal(providers.mapToRoot('/repo/src/app.ts', root, []), 'src/app.ts');

  // An isolated worktree records a different absolute path for the same file.
  assert.equal(
    providers.mapToRoot('/tmp/wt-9/src/app.ts', root, ['src/app.ts']),
    'src/app.ts',
  );
  // A more specific candidate does not create ambiguity: only one suffix-matches.
  assert.equal(
    providers.mapToRoot('/tmp/wt-9/src/app.ts', root, ['src/app.ts', 'vendor/src/app.ts']),
    'src/app.ts',
  );
  // Genuinely ambiguous — both candidates suffix-match. Refuse rather than guess (→ hybrid).
  assert.equal(providers.mapToRoot('/tmp/wt-9/src/app.ts', root, ['src/app.ts', 'app.ts']), null);
  // Outside the candidate entirely.
  assert.equal(providers.mapToRoot('/elsewhere/other.ts', root, ['src/app.ts']), null);
});

// ---------- codex provenance extraction ----------

const CODEX_META = { timestamp: '2026-08-01T00:00:00.000Z', type: 'session_meta', payload: { id: 's1' } };

function codexPatchEntry(file, unifiedDiff, success = true) {
  return {
    timestamp: '2026-08-01T00:00:10.000Z',
    type: 'event_msg',
    payload: {
      type: 'patch_apply_end',
      success,
      changes: { [file]: { type: 'update', unified_diff: unifiedDiff } },
    },
  };
}

test('codex provider: extracts applied diffs as patch ops, skips failed applies', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'sess.jsonl');
    writeJsonl(file, [
      CODEX_META,
      { timestamp: '2026-08-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', id: 'msg_a', role: 'user', content: [] } },
      codexPatchEntry('/repo/src/app.ts', '@@ -1,1 +1,1 @@\n-old\n+new\n'),
      // A rejected patch changed nothing on disk and must not enter the replay.
      codexPatchEntry('/repo/src/ghost.ts', '@@ -1,1 +1,1 @@\n-a\n+b\n', false),
      { timestamp: '2026-08-01T00:00:20.000Z', type: 'response_item', payload: { type: 'message', id: 'msg_z', role: 'assistant', content: [] } },
    ]);

    const { ops, segment } = providers.providerFor('codex').extractFileOps(file, '/repo', []);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'patch');
    assert.equal(ops[0].file, 'src/app.ts');
    // Codex stores a bare hunk list; the provider re-headers it for `git apply`.
    assert.match(ops[0].patch, /^--- a\/src\/app\.ts\n\+\+\+ b\/src\/app\.ts\n@@ /);
    assert.deepEqual(segment, { from: 'msg_a', to: 'msg_z' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex provider: locates rollouts by filename, ignoring non-rollout files', () => {
  const home = tmpdir('mdc-codex-home-');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const sid = '019fdde4-42e3-74b2-8a56-d072b23ef056';
    const day = path.join(home, 'sessions', '2026', '08', '07');
    writeJsonl(path.join(day, `rollout-2026-08-07T13-22-31-${sid}.jsonl`), [CODEX_META]);
    writeJsonl(path.join(day, 'notes.jsonl'), [{ nope: true }]);

    assert.equal(codexSessionIdFromName(`rollout-2026-08-07T13-22-31-${sid}.jsonl`), sid);
    assert.equal(codexSessionIdFromName('notes.jsonl'), null);

    const found = providers.locateSession(`codex:${sid}`, tmpdir());
    assert.ok(found, 'rollout should be discoverable by session id');
    assert.equal(found.scheme, 'codex');
    assert.equal(path.basename(found.path), `rollout-2026-08-07T13-22-31-${sid}.jsonl`);

    assert.equal(providers.locateSession(`codex:${'0'.repeat(36)}`, tmpdir()), null);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('locate: the vendored copy wins, so a fresh clone can still verify', () => {
  const root = tmpdir();
  try {
    const vendoredPath = path.join(root, '.comments', 'sessions', 'sess-v.jsonl');
    writeJsonl(vendoredPath, [CODEX_META]);
    const found = providers.locateSession('codex:sess-v', root);
    assert.equal(found.path, vendoredPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- scheme sniffing ----------

test('sniffScheme: session_meta means codex, anything else means claude', () => {
  const dir = tmpdir();
  try {
    const codexFile = path.join(dir, 'c.jsonl');
    writeJsonl(codexFile, [CODEX_META]);
    const claudeFile = path.join(dir, 'k.jsonl');
    writeJsonl(claudeFile, [{ uuid: 'u1', type: 'user', message: { content: 'hi' } }]);
    const garbage = path.join(dir, 'g.jsonl');
    fs.writeFileSync(garbage, 'not json at all\n');

    for (const sniff of [providers.sniffScheme, sniffScheme]) {
      assert.equal(sniff(codexFile), 'codex');
      assert.equal(sniff(claudeFile), 'claude');
      // Unreadable ⇒ claude, which is also right for pre-v0.12 vendoring.
      assert.equal(sniff(garbage), 'claude');
      assert.equal(sniff(path.join(dir, 'missing.jsonl')), 'claude');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- codex → SessionGraph ----------

test('loadCodexGraph: linear spine, tool calls attached, developer preamble dropped', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'g.jsonl');
    writeJsonl(file, [
      CODEX_META,
      // Harness scaffolding — must not appear as conversation.
      { type: 'response_item', payload: { type: 'message', id: 'msg_dev', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] } },
      { type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'fix the retry loop' }] } },
      { type: 'response_item', payload: { type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', input: 'tools.exec_command({cmd:"ls"})' } },
    ]);

    const g = loadCodexGraph(file, 'sess-g');
    assert.equal(g.sessionId, 'sess-g');
    assert.deepEqual(g.messages.map((m) => m.uuid), ['msg_1', 'msg_2']);
    assert.deepEqual(g.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(g.messages[0].parentUuid, null);
    assert.equal(g.messages[1].parentUuid, 'msg_1');
    // Codex has no reply tree, so there is nothing to fork.
    assert.deepEqual(g.forks, []);
    assert.deepEqual(g.mainPath, ['msg_1', 'msg_2']);
    // The tool call lands on the assistant turn that made it.
    assert.equal(g.messages[1].toolUses.length, 1);
    assert.equal(g.messages[1].toolUses[0].name, 'exec');
    assert.match(g.title, /fix the retry loop/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadCodexGraph: a compaction starts a new spine segment', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'c.jsonl');
    writeJsonl(file, [
      CODEX_META,
      { type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'first' }] } },
      { type: 'compacted', payload: { message: 'summary…' } },
      { type: 'response_item', payload: { type: 'message', id: 'm2', role: 'user', content: [{ type: 'input_text', text: 'second' }] } },
    ]);

    const g = loadCodexGraph(file, 'sess-c');
    assert.equal(g.messages[0].parentUuid, null);
    // Post-compaction messages are a separate root, not children of the old spine.
    assert.equal(g.messages[1].parentUuid, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- provider: cursor ----------

const { loadCursorGraph } = require('../out/sessionProviders.js');

/** Cursor transcripts are {role, message:{content:[blocks]}} with NO ids. */
function cursorEntry(role, blocks) {
  return { role, message: { content: blocks } };
}
const cursorTool = (name, input) => ({ type: 'tool_use', name, input });

test('cursor provider: Write / StrReplace / Delete become content ops', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'c.jsonl');
    writeJsonl(file, [
      cursorEntry('user', [{ type: 'text', text: 'do it' }]),
      cursorEntry('assistant', [cursorTool('Write', { path: '/repo/src/new.ts', contents: 'hello\n' })]),
      cursorEntry('assistant', [
        cursorTool('StrReplace', { path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' }),
      ]),
      cursorEntry('assistant', [cursorTool('Delete', { path: '/repo/src/gone.ts' })]),
      // Read-only tools contribute nothing to provenance.
      cursorEntry('assistant', [cursorTool('Read', { path: '/repo/src/app.ts' })]),
      // Shell edits are invisible by design — that is what makes them hybrid.
      cursorEntry('assistant', [cursorTool('Shell', { command: "sed -i '' s/x/y/ /repo/src/app.ts" })]),
    ]);

    const { ops, segment } = providers.providerFor('cursor').extractFileOps(file, '/repo', []);
    assert.deepEqual(
      ops.map((o) => [o.tool, o.file]),
      [
        ['Write', 'src/new.ts'],
        ['Edit', 'src/app.ts'],
        ['Write', 'src/gone.ts'],
      ],
    );
    assert.equal(ops[0].input.content, 'hello\n');
    assert.deepEqual(ops[1].input, { old_string: 'a', new_string: 'b' });
    // Delete replays as "file is now empty", which is how the replayer compares
    // against a path that no longer exists at head.
    assert.equal(ops[2].input.content, '');

    // Cursor entries carry no id, so segment endpoints are synthesized from the
    // entry index — and only entries that actually mutated files count.
    assert.deepEqual(segment, { from: 'm1', to: 'm3' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor provider: a character-indexed string input is reassembled', () => {
  // Cursor sometimes serializes a string tool input as {"0":"a","1":"b",…}.
  const spread = {};
  const text = '*** Begin Patch\n*** End Patch';
  [...text].forEach((ch, i) => (spread[String(i)] = ch));
  assert.equal(providers.reassembleStringInput(spread), text);
  assert.equal(providers.reassembleStringInput(text), text);
  assert.equal(providers.reassembleStringInput({ notNumeric: 'x' }), '');
});

test('cursor provider: ApplyPatch envelopes convert to context-matched replacements', () => {
  // The apply-patch ENVELOPE has no @@ -a,b +c,d line numbers, so it cannot go
  // to `git apply` — each hunk becomes an old→new block swap instead.
  const envelope = [
    '*** Begin Patch',
    '*** Update File: /repo/src/app.ts',
    '@@',
    ' function main() {',
    '-  return 42;',
    '+  return 43;',
    ' }',
    '*** End Patch',
  ].join('\n');

  const hunks = providers.parseApplyPatchEnvelope(envelope);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].path, '/repo/src/app.ts');
  assert.equal(hunks[0].oldText, 'function main() {\n  return 42;\n}');
  assert.equal(hunks[0].newText, 'function main() {\n  return 43;\n}');

  const dir = tmpdir();
  try {
    const file = path.join(dir, 'p.jsonl');
    writeJsonl(file, [cursorEntry('assistant', [cursorTool('ApplyPatch', envelope)])]);
    const { ops } = providers.providerFor('cursor').extractFileOps(file, '/repo', []);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].file, 'src/app.ts');
    assert.equal(ops[0].input.old_string, 'function main() {\n  return 42;\n}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor provider: locates a transcript by its session-id directory', () => {
  const dir = tmpdir();
  try {
    // Vendored copies win, which is what lets a fresh clone verify.
    const sid = '8c6e09e8-ef50-443c-a5b0-ebf683645acc';
    const vendoredPath = path.join(dir, '.comments', 'sessions', `${sid}.jsonl`);
    writeJsonl(vendoredPath, [cursorEntry('user', [{ type: 'text', text: 'hi' }])]);
    const found = providers.locateSession(`cursor:${sid}`, dir);
    assert.equal(found.scheme, 'cursor');
    assert.equal(found.path, vendoredPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sniffScheme: an id-less {role, message} entry means cursor', () => {
  const dir = tmpdir();
  try {
    const cursorFile = path.join(dir, 'cur.jsonl');
    writeJsonl(cursorFile, [cursorEntry('user', [{ type: 'text', text: 'hi' }])]);
    // The discriminator is the ABSENCE of an id: claude entries always have one.
    const claudeFile = path.join(dir, 'cl.jsonl');
    writeJsonl(claudeFile, [{ uuid: 'u1', type: 'user', message: { content: 'hi' } }]);

    for (const sniff of [providers.sniffScheme, sniffScheme]) {
      assert.equal(sniff(cursorFile), 'cursor');
      assert.equal(sniff(claudeFile), 'claude');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadCursorGraph: linear spine, synthesized ids, user_query unwrapped', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'g.jsonl');
    writeJsonl(file, [
      cursorEntry('user', [
        { type: 'text', text: '<timestamp>Mon</timestamp>\n<user_query>\nfix the retry loop\n</user_query>' },
      ]),
      cursorEntry('assistant', [
        { type: 'text', text: 'on it' },
        cursorTool('Shell', { command: 'ls', description: 'list files' }),
      ]),
    ]);

    const g = loadCursorGraph(file, 'sess-cur');
    assert.deepEqual(g.messages.map((m) => m.uuid), ['m0', 'm1']);
    assert.equal(g.messages[0].parentUuid, null);
    assert.equal(g.messages[1].parentUuid, 'm0');
    assert.deepEqual(g.forks, []); // no reply tree exists to fork
    // The prompt is shown, not the harness scaffolding around it.
    assert.equal(g.messages[0].text, 'fix the retry loop');
    assert.match(g.title, /fix the retry loop/);
    assert.equal(g.messages[1].toolUses[0].name, 'Shell');
    assert.equal(g.messages[1].toolUses[0].summary, 'list files');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
