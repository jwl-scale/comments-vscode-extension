'use strict';
/** Hermetic test workspaces: a real git repo per run, built in the OS tmpdir. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Base fixture: committed source files, clean tree. Returns the repo root. */
function buildBaseFixture(prefix = 'mdc-e2e-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@test');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'app.ts'),
    'function main() {\n  const x = compute();\n  return 42;\n}\n',
  );
  fs.writeFileSync(
    path.join(root, 'src', 'rebase.ts'),
    ['// header', 'export function retry() {', '  let delay = 100;', '  return delay;', '}', ''].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'src', 'legacy.ts'), 'export const LEGACY = true;\n');
  fs.writeFileSync(
    path.join(root, 'notes.md'),
    '# Design notes\n\nThe retry loop has no jitter yet.\n\nA second paragraph for selection tests.\n',
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture init');
  return root;
}

/** UI fixture: base + a pre-seeded v2 thread on notes.md + a vendored session. */
function buildUiFixture() {
  const root = buildBaseFixture('mdc-ui-');
  const head = git(root, 'rev-parse', 'HEAD').trim();

  // Thread anchored to "no jitter yet" (line 2 of notes.md, 0-based).
  const threadsDir = path.join(root, '.comments', 'threads');
  fs.mkdirSync(threadsDir, { recursive: true });
  const notes = fs.readFileSync(path.join(root, 'notes.md'), 'utf8');
  const target = 'no jitter yet';
  const offset = notes.indexOf(target);
  const line = notes.slice(0, offset).split('\n').length - 1;
  const char = offset - (notes.lastIndexOf('\n', offset - 1) + 1);
  const created = {
    id: 'ev_ui_fixture_1',
    type: 'created',
    seq: 1,
    ts: '2026-08-01T00:00:00.000Z',
    actor: { name: 'fixture', kind: 'human' },
    version: 2,
    file: 'notes.md',
    anchor: {
      baseline: { kind: 'commit', sha: head },
      start: { line, char },
      end: { line, char: char + target.length },
      text: target,
      prefix: notes.slice(Math.max(0, offset - 120), offset),
      suffix: notes.slice(offset + target.length, offset + target.length + 120),
    },
    body: 'Add jitter before we ship this.',
    commentId: 'c_ui_fixture_1',
    severity: 'normal',
  };
  fs.writeFileSync(path.join(threadsDir, 'th_ui-fixture.jsonl'), JSON.stringify(created) + '\n');

  // Vendored session for the conversation graph (reuses the parser fixtures).
  const fixtures = path.join(__dirname, '..', 'fixtures');
  const sessions = path.join(root, '.comments', 'sessions');
  fs.mkdirSync(path.join(sessions, 'parent-session', 'subagents'), { recursive: true });
  fs.copyFileSync(path.join(fixtures, 'parent-session.jsonl'), path.join(sessions, 'parent-session.jsonl'));
  for (const f of fs.readdirSync(path.join(fixtures, 'parent-session', 'subagents'))) {
    fs.copyFileSync(
      path.join(fixtures, 'parent-session', 'subagents', f),
      path.join(sessions, 'parent-session', 'subagents', f),
    );
  }
  return root;
}

module.exports = { buildBaseFixture, buildUiFixture, git };
