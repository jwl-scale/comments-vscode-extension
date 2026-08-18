const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const QUEUE = path.join(__dirname, '..', 'bin', 'comments-queue.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function runQueue(cwd, args) {
  const res = spawnSync(process.execPath, [QUEUE, ...args], { cwd, encoding: 'utf8' });
  let json;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, stderr: res.stderr, stdout: res.stdout };
}

const APP = 'function main() {\n  const x = 1;\n  return 42;\n}\n';

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-queue-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), APP);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

let evSeq = 0;
function writeThread(root, threadId, { text, severity = 'normal', extraEvents = [], file = 'src/app.ts', content = APP }) {
  const sha = git(root, 'rev-parse', 'HEAD');
  const offset = content.indexOf(text);
  const before = content.slice(0, offset);
  const line = before.split('\n').length - 1;
  const char = offset - (content.lastIndexOf('\n', offset - 1) + 1);
  const events = [
    {
      id: `ev_t${++evSeq}`,
      type: 'created',
      seq: 1,
      ts: '2026-08-01T00:00:00.000Z',
      actor: { name: 'tester', kind: 'human' },
      version: 2,
      file,
      anchor: {
        baseline: { kind: 'commit', sha },
        start: { line, char },
        end: { line, char: char + text.length },
        text,
        prefix: '',
        suffix: '',
      },
      body: `about ${text}`,
      commentId: `c_t${evSeq}`,
      severity,
    },
    ...extraEvents.map((e, i) => ({
      id: `ev_t${++evSeq}`,
      seq: 2 + i,
      ts: '2026-08-01T01:00:00.000Z',
      actor: { name: 'tester', kind: 'human' },
      ...e,
    })),
  ];
  const dir = path.join(root, '.comments', 'threads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${threadId}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function writeSession(root, sessionId, ops) {
  const dir = path.join(root, '.comments', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const lines = ops.map((op, i) =>
    JSON.stringify({
      uuid: `u${i + 1}`,
      message: { content: [{ type: 'tool_use', name: op.tool, input: op.input }] },
    }),
  );
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

/**
 * A Codex rollout records the diff it actually applied, so the fixture is the
 * patch itself rather than edit parameters (docs/spec/session-providers.md).
 */
function writeCodexSession(root, sessionId, patches) {
  const dir = path.join(root, '.comments', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: '2026-08-01T00:00:00.000Z', type: 'session_meta', payload: { id: sessionId } }),
    JSON.stringify({
      timestamp: '2026-08-01T00:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] },
    }),
    ...patches.map((p, i) =>
      JSON.stringify({
        timestamp: `2026-08-01T00:00:1${i}.000Z`,
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          success: true,
          changes: { [path.join(root, p.file)]: { type: 'update', unified_diff: p.diff } },
        },
      }),
    ),
    JSON.stringify({
      timestamp: '2026-08-01T00:00:30.000Z',
      type: 'response_item',
      payload: { type: 'message', id: 'msg_9', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    }),
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

/**
 * A Cursor transcript: {role, message:{content:[blocks]}} with no ids at all.
 * Edit tools are Write/StrReplace/Delete/ApplyPatch.
 */
function writeCursorSession(root, sessionId, calls) {
  const dir = path.join(root, '.comments', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>fix it</user_query>' }] } }),
    ...calls.map((c) =>
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'tool_use', name: c.name, input: c.input }] },
      }),
    ),
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function makeCandidate(root, branch, newContent) {
  git(root, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), newContent);
  git(root, 'commit', '-qam', 'fix: address review thread');
  git(root, 'checkout', '-q', 'main');
}

test('check: open blocking threads on touched files gate the diff', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_block', { text: 'return 42;', severity: 'blocking' });
    makeCandidate(root, 'fix', APP.replace('return 42;', 'return 43;'));

    const fail = runQueue(root, ['check', '--base', 'main', '--head', 'fix']);
    assert.equal(fail.status, 1, fail.stderr);
    assert.equal(fail.json.findings[0].threadId, 'th_block');

    const allowed = runQueue(root, ['check', '--base', 'main', '--head', 'fix', '--allow', 'th_block']);
    assert.equal(allowed.status, 0);

    // Non-blocking threads never gate.
    fs.rmSync(path.join(root, '.comments', 'threads', 'th_block.jsonl'));
    writeThread(root, 'th_nit', { text: 'return 42;', severity: 'normal' });
    assert.equal(runQueue(root, ['check', '--base', 'main', '--head', 'fix']).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land: full pipeline — verify, stamp, land, metadata, sweep, prune', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_fix', { text: 'return 42;', severity: 'blocking' });
    writeThread(root, 'th_other', { text: 'const x = 1;' }); // survives, re-baselines
    writeThread(root, 'th_collide', { text: 'return 42;' }); // anchor rewritten → flagged
    writeThread(root, 'th_old', {
      text: 'function main',
      extraEvents: [{ type: 'resolved', reason: 'wontfix' }],
    }); // resolved earlier → pruned
    const fixed = APP.replace('return 42;', 'return answer();');
    makeCandidate(root, 'fix', fixed);
    writeSession(root, 'sess-land', [
      { tool: 'Edit', input: { file_path: 'src/app.ts', old_string: 'return 42;', new_string: 'return answer();' } },
    ]);

    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_fix', '--session', 'sess-land']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.provenance, 'agent', JSON.stringify(res.json.unexplained));

    // History: metadata commit on top of the stamped code commit.
    const metaMsg = git(root, 'log', '-1', '--format=%B');
    assert.match(metaMsg, /Comments-Meta-For: [0-9a-f]{40}/);
    const codeMsg = git(root, 'log', '-1', '--skip=1', '--format=%B');
    assert.match(codeMsg, /Comments-Resolves: th_fix/);
    assert.match(codeMsg, /Agent-Session: claude:sess-land#u1\.\.u1/);
    assert.match(codeMsg, /Provenance: agent/);
    assert.equal(git(root, 'show', 'HEAD~1:src/app.ts'), fixed.trimEnd());

    // Thread events: resolved(fixed, landedSha) + released on the addressed thread.
    const fixEvents = fs
      .readFileSync(path.join(root, '.comments', 'threads', 'th_fix.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    const resolved = fixEvents.find((e) => e.type === 'resolved');
    assert.equal(resolved.reason, 'fixed');
    assert.equal(resolved.sha, res.json.landedSha);
    assert.ok(fixEvents.some((e) => e.type === 'released'));

    // Sweep: untouched-anchor thread re-baselined to the landed sha…
    assert.deepEqual(res.json.reanchored, ['th_other']);
    const otherEvents = fs
      .readFileSync(path.join(root, '.comments', 'threads', 'th_other.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    const re = otherEvents.find((e) => e.type === 'reanchored');
    assert.equal(re.anchor.baseline.sha, res.json.landedSha);
    assert.equal(re.method, 'diff');
    // …collided anchor flagged with a notary reply instead of a guess.
    assert.equal(res.json.flagged[0].threadId, 'th_collide');

    // Prune: previously-resolved thread file removed (history keeps it).
    assert.deepEqual(res.json.pruned, ['th_old']);
    assert.equal(fs.existsSync(path.join(root, '.comments', 'threads', 'th_old.jsonl')), false);

    // Brief written and committed.
    const brief = fs.readFileSync(path.join(root, '.comments', 'briefs', `${res.json.landedSha}.md`), 'utf8');
    assert.match(brief, /provenance: agent/);
    assert.match(brief, /threads resolved: th_fix/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land: unexplained diff bytes verify as hybrid, listed in the brief', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_fix', { text: 'return 42;' });
    // Candidate contains an edit the session does NOT account for.
    makeCandidate(root, 'fix', APP.replace('return 42;', 'return answer();').replace('const x = 1;', 'const x = 2;'));
    writeSession(root, 'sess-partial', [
      { tool: 'Edit', input: { file_path: 'src/app.ts', old_string: 'return 42;', new_string: 'return answer();' } },
    ]);
    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_fix', '--session', 'sess-partial']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'hybrid');
    assert.deepEqual(res.json.unexplained, ['src/app.ts']);
    assert.match(git(root, 'log', '-1', '--skip=1', '--format=%B'), /Provenance: hybrid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land: rejected by another open blocking thread on a touched file', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_mine', { text: 'return 42;' });
    writeThread(root, 'th_blocker', { text: 'const x = 1;', severity: 'blocking' });
    makeCandidate(root, 'fix', APP.replace('return 42;', 'return 43;'));
    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_mine']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /blocked by open blocking thread\(s\): th_blocker/);
    // Nothing landed; lock released for the next attempt.
    assert.equal(git(root, 'log', '--oneline').split('\n').length, 1);
    assert.equal(fs.existsSync(path.join(root, '.git', 'comments-queue.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land: no session → Provenance: human', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_fix', { text: 'return 42;' });
    makeCandidate(root, 'fix', APP.replace('return 42;', 'return 43;'));
    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_fix']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'human');
    assert.match(git(root, 'log', '-1', '--skip=1', '--format=%B'), /Provenance: human/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land-suggestion: packages an open suggestion into a verified landing', () => {
  const root = mkRepo();
  try {
    const patch = [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,4 +1,4 @@',
      ' function main() {',
      '   const x = 1;',
      '-  return 42;',
      '+  return answer();',
      ' }',
      '',
    ].join('\n');
    writeThread(root, 'th_sug', {
      text: 'return 42;',
      extraEvents: [
        {
          type: 'suggested',
          suggestionId: 's_1',
          patch,
          actor: { name: 'claude', kind: 'agent', session: 'sess-sug' },
        },
      ],
    });
    // The suggesting session's transcript contains the attach_suggestion call —
    // the replayer applies the patch, so suggest-only flows verify as agent.
    writeSession(root, 'sess-sug', [{ tool: 'mcp__comments__attach_suggestion', input: { threadId: 'th_sug', patch } }]);

    const res = runQueue(root, ['land-suggestion', '--thread', 'th_sug']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'agent', JSON.stringify(res.json.unexplained));
    assert.match(git(root, 'show', 'HEAD~1:src/app.ts'), /return answer\(\);/);
    const codeMsg = git(root, 'log', '-1', '--skip=1', '--format=%B');
    assert.match(codeMsg, /Comments-Resolves: th_sug/);
    assert.match(codeMsg, /Agent-Session: claude:sess-sug#u1\.\.u1/);

    const events = fs
      .readFileSync(path.join(root, '.comments', 'threads', 'th_sug.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.ok(events.some((e) => e.type === 'suggestion_accepted' && e.suggestionId === 's_1'));
    assert.ok(events.some((e) => e.type === 'resolved' && e.reason === 'fixed'));
    assert.equal(git(root, 'status', '--porcelain'), '', 'working tree left clean');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Fake fixer CLI: edits the anchored text in its worktree, replies to the
 *  thread, and writes a matching vendored transcript so provenance verifies. */
function writeFakeFixer(root) {
  const script = path.join(root, 'fake-fixer.js');
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const threadId = prompt.match(/th_[A-Za-z0-9-]+/)[0];
const file = prompt.match(/— (\\S+), lines/)[1];
const anchor = prompt.match(/\\n\`\`\`\\n([\\s\\S]*?)\\n\`\`\`\\n/)[1];
const root = process.env.MD_COMMENTS_ROOT;
const sid = process.env.MD_COMMENTS_SESSION;
// Fix in the worktree (cwd).
const abs = path.join(process.cwd(), file);
const fixed = 'FIXED_' + threadId + '()';
fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(anchor, fixed));
// Reply to the live store, stamped with the session (as the MCP server would).
const log = path.join(root, '.comments', 'threads', threadId + '.jsonl');
const seq = fs.readFileSync(log, 'utf8').trim().split('\\n')
  .map((l) => { try { return JSON.parse(l).seq || 0; } catch { return 0; } })
  .reduce((a, b) => Math.max(a, b), 0) + 1;
fs.appendFileSync(log, JSON.stringify({
  id: 'ev_ff_' + Math.random().toString(36).slice(2), type: 'replied', seq,
  ts: new Date().toISOString(), actor: { name: 'claude', kind: 'agent', session: sid },
  commentId: 'c_ff_' + threadId, body: 'Replaced with ' + fixed,
}) + '\\n');
// Vendored transcript with the matching Edit op -> provenance verifies as agent.
const sess = path.join(root, '.comments', 'sessions', sid + '.jsonl');
fs.mkdirSync(path.dirname(sess), { recursive: true });
fs.writeFileSync(sess, JSON.stringify({
  uuid: 'u1',
  message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file, old_string: anchor, new_string: fixed } }] },
}) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: sid }) + '\\n');
`,
    { mode: 0o755 },
  );
  return script;
}

test('fleet: worktree-per-fixer over two threads, landed serially with agent provenance', async () => {
  const root = mkRepo();
  try {
    const B = 'export function helper() {\n  return "slow";\n}\n';
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), B);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'add b');
    writeThread(root, 'th_a1', { text: 'return 42;', severity: 'blocking' });
    writeThread(root, 'th_b1', { text: 'return "slow";', file: 'src/b.ts', content: B });
    const fake = writeFakeFixer(root);

    const res = runQueue(root, ['fleet', '--threads', 'th_a1,th_b1', '--claude', fake, '--parallel', '2']);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(res.json.ok, true);
    const landed = res.json.results.filter((r) => r.status === 'landed');
    assert.equal(landed.length, 2, JSON.stringify(res.json.results));
    assert.ok(landed.every((r) => r.provenance === 'agent'), JSON.stringify(landed));

    // Both fixes in history: 2 code + 2 metadata commits on top of the base 2.
    assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '6');
    assert.match(git(root, 'show', 'HEAD:src/app.ts'), /FIXED_th_a1/);
    assert.match(fs.readFileSync(path.join(root, 'src', 'b.ts'), 'utf8'), /FIXED_th_b1/);

    // Threads resolved + released; blocking sibling didn't gate the other landing.
    // Whichever thread landed FIRST gets pruned by the second landing — its
    // history lives in git, exactly as the spec promises.
    const threadEvents = (id) => {
      const p = path.join(root, '.comments', 'threads', `${id}.jsonl`);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim().split('\n').map(JSON.parse);
      for (const rev of git(root, 'rev-list', 'HEAD').split('\n')) {
        try {
          return execFileSync('git', ['show', `${rev}:.comments/threads/${id}.jsonl`], { cwd: root, encoding: 'utf8' })
            .trim().split('\n').map(JSON.parse);
        } catch {
          /* keep walking */
        }
      }
      throw new Error(`${id} not found in working tree or history`);
    };
    for (const id of ['th_a1', 'th_b1']) {
      const events = threadEvents(id);
      assert.ok(events.some((e) => e.type === 'resolved' && e.reason === 'fixed'), id);
      assert.ok(events.some((e) => e.type === 'claimed'), id);
      assert.ok(events.some((e) => e.type === 'released'), id);
      assert.ok(events.some((e) => e.type === 'replied' && /Replaced with/.test(e.body)), id);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provenance replay merges Task-subagent transcripts', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_multi', { text: 'return 42;' });
    // Candidate contains TWO edits: one from the main transcript, one delegated
    // to a Task subagent (whose ops live in a sibling transcript file).
    makeCandidate(root, 'fix', APP.replace('return 42;', 'return answer();').replace('const x = 1;', 'const x = one();'));
    writeSession(root, 'sess-split', [
      { tool: 'Edit', input: { file_path: 'src/app.ts', old_string: 'return 42;', new_string: 'return answer();' } },
    ]);
    const subDir = path.join(root, '.comments', 'sessions', 'sess-split', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'agent-abc.jsonl'),
      JSON.stringify({
        uuid: 'sub-u1',
        timestamp: '2026-08-03T00:00:01.000Z',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts', old_string: 'const x = 1;', new_string: 'const x = one();' } }] },
      }) + '\n',
    );

    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_multi', '--session', 'sess-split']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'agent', JSON.stringify(res.json.unexplained));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land --keep-conflicts preserves the conflicted rebase for deliberate resolution', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_c', { text: 'return 42;' });
    makeCandidate(root, 'fix', APP.replace('return 42;', 'return answer();'));
    // Advance the target with a CONFLICTING change on the same line.
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), APP.replace('return 42;', 'return 41;'));
    git(root, 'commit', '-qam', 'conflicting mainline change');

    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_c', '--keep-conflicts']);
    assert.equal(res.status, 1, res.stderr);
    assert.equal(res.json.error, 'rebase-conflict');
    assert.ok(fs.existsSync(res.json.conflict.worktree), 'conflicted worktree preserved');
    assert.deepEqual(res.json.conflict.files, ['src/app.ts']);
    assert.match(res.json.conflict.resume, /rebase --continue/);
    assert.equal(fs.existsSync(path.join(root, '.git', 'comments-queue.lock')), false, 'lock released');
    execFileSync('git', ['worktree', 'remove', '--force', res.json.conflict.worktree], { cwd: root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land --no-prune keeps previously-resolved thread files in the working tree', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_go', { text: 'return 42;' });
    writeThread(root, 'th_done', { text: 'function main', extraEvents: [{ type: 'resolved', reason: 'wontfix' }] });
    makeCandidate(root, 'fix', APP.replace('return 42;', 'return 43;'));
    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_go', '--no-prune']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(res.json.pruned, []);
    assert.ok(fs.existsSync(path.join(root, '.comments', 'threads', 'th_done.jsonl')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provenance replay maps worktree-absolute Edit paths by suffix (worktree regression)', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_wt', { text: 'return 42;' });
    makeCandidate(root, 'fix', APP.replace('return 42;', 'return answer();'));
    // The agent edited in an isolated worktree: file_path is worktree-absolute,
    // NOT under the repo root. Previously these ops were dropped → hybrid.
    writeSession(root, 'sess-wt', [
      {
        tool: 'Edit',
        input: {
          file_path: '/private/tmp/some-scratchpad/wt-1532/src/app.ts',
          old_string: 'return 42;',
          new_string: 'return answer();',
        },
      },
    ]);
    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_wt', '--session', 'sess-wt']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'agent', JSON.stringify(res.json.unexplained));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provenance replay understands MultiEdit sequences', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_me', { text: 'return 42;' });
    makeCandidate(root, 'fix', APP.replace('return 42;', 'return answer();').replace('const x = 1;', 'const x = 2;'));
    writeSession(root, 'sess-me', [
      {
        tool: 'MultiEdit',
        input: {
          file_path: 'src/app.ts',
          edits: [
            { old_string: 'return 42;', new_string: 'return answer();' },
            { old_string: 'const x = 1;', new_string: 'const x = 2;' },
          ],
        },
      },
    ]);
    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_me', '--session', 'sess-me']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'agent', JSON.stringify(res.json.unexplained));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land: a codex session verifies as agent from its applied patches', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_cx', { text: 'return 42;', severity: 'blocking' });
    const fixed = APP.replace('return 42;', 'return answer();');
    makeCandidate(root, 'fix', fixed);
    writeCodexSession(root, 'sess-cx', [
      {
        file: 'src/app.ts',
        diff: '@@ -1,4 +1,4 @@\n function main() {\n   const x = 1;\n-  return 42;\n+  return answer();\n }\n',
      },
    ]);

    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_cx', '--session', 'codex:sess-cx']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'agent', JSON.stringify(res.json.unexplained));

    const codeMsg = git(root, 'log', '-1', '--skip=1', '--format=%B');
    assert.match(codeMsg, /Agent-Session: codex:sess-cx#msg_1\.\.msg_9/);
    assert.match(codeMsg, /Provenance: agent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land: a codex session that did not explain the diff verifies as hybrid', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_cx2', { text: 'return 42;' });
    // The tree changes two lines; the transcript only accounts for one — the
    // other was made by a shell command the provider cannot observe.
    const fixed = APP.replace('return 42;', 'return answer();').replace('const x = 1;', 'const x = 2;');
    makeCandidate(root, 'fix', fixed);
    writeCodexSession(root, 'sess-cx2', [
      {
        file: 'src/app.ts',
        diff: '@@ -1,4 +1,4 @@\n function main() {\n   const x = 1;\n-  return 42;\n+  return answer();\n }\n',
      },
    ]);

    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_cx2', '--session', 'codex:sess-cx2']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'hybrid');
    assert.deepEqual(res.json.unexplained, ['src/app.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land: legacy bare session refs still resolve as claude', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_legacy', { text: 'return 42;' });
    const fixed = APP.replace('return 42;', 'return answer();');
    makeCandidate(root, 'fix', fixed);
    writeSession(root, 'sess-legacy', [
      { tool: 'Edit', input: { file_path: 'src/app.ts', old_string: 'return 42;', new_string: 'return answer();' } },
    ]);

    // No scheme on --session: the pre-v0.12 spelling, which must keep working.
    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_legacy', '--session', 'sess-legacy']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'agent', JSON.stringify(res.json.unexplained));
    // …but it is written back in the new, scheme-qualified form.
    const codeMsg = git(root, 'log', '-1', '--skip=1', '--format=%B');
    assert.match(codeMsg, /Agent-Session: claude:sess-legacy#u1\.\.u1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land: a cursor session verifies as agent from its StrReplace calls', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_cur', { text: 'return 42;', severity: 'blocking' });
    const fixed = APP.replace('return 42;', 'return answer();');
    makeCandidate(root, 'fix', fixed);
    writeCursorSession(root, 'sess-cur', [
      { name: 'Read', input: { path: path.join(root, 'src/app.ts') } }, // read-only: no provenance
      {
        name: 'StrReplace',
        input: { path: path.join(root, 'src/app.ts'), old_string: 'return 42;', new_string: 'return answer();' },
      },
    ]);

    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_cur', '--session', 'cursor:sess-cur']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'agent', JSON.stringify(res.json.unexplained));

    const codeMsg = git(root, 'log', '-1', '--skip=1', '--format=%B');
    // Cursor entries have no ids, so the segment is positional (m<index>) and
    // spans only the entries that actually mutated files.
    assert.match(codeMsg, /Agent-Session: cursor:sess-cur#m2\.\.m2/);
    assert.match(codeMsg, /Provenance: agent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land: a cursor ApplyPatch envelope replays as agent', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_ap', { text: 'return 42;' });
    const fixed = APP.replace('return 42;', 'return answer();');
    makeCandidate(root, 'fix', fixed);
    // The envelope has no @@ -a,b +c,d line numbers — it must be applied by
    // matching context, not handed to `git apply`.
    const envelope = [
      '*** Begin Patch',
      `*** Update File: ${path.join(root, 'src/app.ts')}`,
      '@@',
      ' function main() {',
      '   const x = 1;',
      '-  return 42;',
      '+  return answer();',
      ' }',
      '*** End Patch',
    ].join('\n');
    writeCursorSession(root, 'sess-ap', [{ name: 'ApplyPatch', input: envelope }]);

    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_ap', '--session', 'cursor:sess-ap']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'agent', JSON.stringify(res.json.unexplained));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('land: a cursor Shell edit is invisible and verifies hybrid', () => {
  const root = mkRepo();
  try {
    writeThread(root, 'th_sh', { text: 'return 42;' });
    makeCandidate(root, 'fix', APP.replace('return 42;', 'return answer();'));
    // Shell is how an agent escapes the replayer's view — by design that costs
    // it `agent`, rather than being silently trusted.
    writeCursorSession(root, 'sess-sh', [
      { name: 'Shell', input: { command: "sed -i '' 's/42/answer()/' src/app.ts" } },
    ]);

    const res = runQueue(root, ['land', '--branch', 'fix', '--threads', 'th_sh', '--session', 'cursor:sess-sh']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.provenance, 'hybrid');
    assert.deepEqual(res.json.unexplained, ['src/app.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
