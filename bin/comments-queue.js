#!/usr/bin/env node
/**
 * The notary (docs/spec/notary.md): serialized landing pipeline + blocking gate.
 * Zero dependencies, standalone plain JS — duplicates the sidecar-v2 format on
 * purpose (like bin/mcp-comments.js); the contract is docs/spec/sidecar-v2.md.
 *
 *   comments-queue check --base <ref> --head <ref> [--allow th_a,th_b]
 *       Fail (exit 1) if any open BLOCKING thread anchors to a file changed
 *       between base..head. CI gate / merge-queue step.
 *
 *   comments-queue land --branch <ref> --threads th_a[,th_b] [--session [<scheme>:]<sid>[,…]]
 *       Rebase the candidate onto the target, gate, run configured checks,
 *       verify provenance by replaying the session's Edit/Write tool calls,
 *       stamp trailers, fast-forward the target, then land a metadata commit
 *       (vendored session, commit brief, thread events, re-anchor sweep,
 *       prunes). Config: .comments/queue.json { "checks": ["npm test"] }.
 *
 * v1 limits (documented deviations from the spec): single-commit candidates
 * only; no automatic rollback of the code commit if the metadata step fails
 * (a loud warning beats reset --hard under a possibly-dirty tree).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const providers = require('./lib/session-providers');

// ---------- git ----------

function git(cwd, args, opts = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (res.status !== 0) {
    const err = new Error(`git ${args.join(' ')}: ${(res.stderr || '').trim()}`);
    err.stderr = res.stderr;
    throw err;
  }
  return res.stdout;
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function resolveRoot() {
  const start = path.resolve(process.env.MD_COMMENTS_ROOT || process.cwd());
  const common = tryGit(start, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common) {
    const commonDir = common.trim();
    if (path.basename(commonDir) === '.git') return path.dirname(commonDir);
  }
  return start;
}

// ---------- sidecar v2 (read + locked append; mirrors bin/mcp-comments.js) ----------

function parseLog(text) {
  const seen = new Set();
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!ev || typeof ev.id !== 'string' || typeof ev.type !== 'string' || seen.has(ev.id)) continue;
    seen.add(ev.id);
    events.push(ev);
  }
  return events.sort(
    (a, b) => (a.seq || 0) - (b.seq || 0) || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) || (a.id < b.id ? -1 : 1),
  );
}

function fold(threadId, events) {
  const created = events.find((e) => e.type === 'created');
  if (!created || typeof created.file !== 'string' || !created.anchor) return null;
  const state = {
    id: threadId,
    file: created.file,
    status: 'open',
    severity: created.severity === 'blocking' ? 'blocking' : 'normal',
    anchor: created.anchor,
    resolvedTs: undefined,
    suggestions: [],
    events,
  };
  for (const ev of events) {
    switch (ev.type) {
      case 'resolved':
        state.status = 'resolved';
        state.resolvedTs = ev.ts;
        break;
      case 'reopened':
        state.status = 'open';
        state.resolvedTs = undefined;
        break;
      case 'severity_changed':
        state.severity = ev.severity === 'blocking' ? 'blocking' : 'normal';
        break;
      case 'reanchored':
        if (ev.anchor) state.anchor = ev.anchor;
        break;
      case 'renamed':
        if (typeof ev.file === 'string') state.file = ev.file;
        break;
      case 'suggested':
        state.suggestions.push({ id: ev.suggestionId || ev.id, status: 'open' });
        break;
      case 'suggestion_accepted':
      case 'suggestion_rejected': {
        const s = state.suggestions.find((x) => x.id === ev.suggestionId);
        if (s) s.status = ev.type === 'suggestion_accepted' ? 'accepted' : 'rejected';
        break;
      }
    }
  }
  return state;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function appendEvent(root, threadId, type, fields) {
  const logPath = path.join(root, '.comments', 'threads', `${threadId}.jsonl`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const lock = logPath + '.lock';
  const deadline = Date.now() + 5000;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out acquiring ${lock}`);
      sleepSync(15);
    }
  }
  try {
    const seq = readThreadEvents(root, threadId).reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
    const event = Object.assign(
      { id: `ev_${crypto.randomUUID()}`, type, seq, ts: new Date().toISOString(), actor: { name: 'notary', kind: 'notary' } },
      fields,
    );
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
    return event;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

function readThreadEvents(root, threadId) {
  const p = path.join(root, '.comments', 'threads', `${threadId}.jsonl`);
  try {
    return parseLog(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function listThreads(root) {
  const dir = path.join(root, '.comments', 'threads');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    const state = fold(id, readThreadEvents(root, id));
    if (state) out.push(state);
  }
  return out;
}

// ---------- check: the blocking gate ----------

function runCheck(root, opts) {
  const changed = new Set(
    git(root, ['diff', '--name-only', `${opts.base}..${opts.head}`]).split('\n').filter(Boolean),
  );
  const allow = new Set(opts.allow || []);
  const findings = listThreads(root).filter(
    (t) => t.status === 'open' && t.severity === 'blocking' && changed.has(t.file) && !allow.has(t.id),
  );
  const report = {
    ok: findings.length === 0,
    base: opts.base,
    head: opts.head,
    findings: findings.map((t) => ({
      threadId: t.id,
      file: t.file,
      line: t.anchor.start.line + 1,
      anchorText: t.anchor.text,
    })),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.ok ? 0 : 1;
}

// ---------- provenance: replay the session's file ops against the base tree ----------
//
// Locating a transcript and extracting its file mutations are provider concerns
// (docs/spec/session-providers.md) — claude replays Edit/Write/MultiEdit calls,
// codex replays the diffs it recorded as actually applied. The notary below is
// provider-independent: it only knows content ops and patch ops.

/** Resolve one `--session` value to { ref, path } via its provider. */
function locateSessionRef(root, raw) {
  const ref = providers.parseSessionRef(raw);
  if (!ref) return null;
  const found = providers.locateSession(ref, root);
  return found ? { ref, path: found.path } : { ref, path: null };
}

/** `--session` accepts a comma-separated list; a commit may cite several sessions. */
function parseSessionList(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Apply a unified diff to the replayed-content map via `git apply` in a scratch dir. */
function applyPatchToReplay(replayed, baseContent, patch) {
  const files = new Set();
  for (const m of patch.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gm)) files.add(m[1].trim());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-replay-'));
  try {
    for (const f of files) {
      const content = replayed.has(f) ? replayed.get(f) : baseContent(f);
      if (content === '' && !replayed.has(f)) continue; // new-file patches must not pre-exist
      const p = path.join(tmp, f);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    const normalized = patch.endsWith('\n') ? patch : patch + '\n';
    const res = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: tmp, input: normalized, encoding: 'utf8' });
    if (res.status !== 0) return { ok: false, error: (res.stderr || '').trim() };
    for (const f of files) {
      const p = path.join(tmp, f);
      replayed.set(f, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
    }
    return { ok: true };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function verifyProvenance(root, baseSha, headSha, sessionSpec) {
  const raws = parseSessionList(sessionSpec);
  if (raws.length === 0) return { level: 'human', unexplained: [], segments: [], refs: [] };

  const changedList = git(root, ['diff', '--name-only', `${baseSha}..${headSha}`]).split('\n').filter(Boolean);

  // Union the ops of every cited session, each in its own transcript order.
  // Cross-session interleaving is not recoverable (separate clocks, separate
  // processes) and does not need to be: replay only has to reproduce the tree.
  const ops = [];
  const segments = [];
  const refs = [];
  const unexplainedOps = [];
  for (const raw of raws) {
    const located = locateSessionRef(root, raw);
    if (!located) {
      unexplainedOps.push(`(unparseable session ref: ${raw})`);
      continue;
    }
    refs.push(located.ref);
    if (!located.path) {
      unexplainedOps.push(`(session transcript not found: ${providers.formatSessionRef(located.ref)})`);
      continue;
    }
    const provider = providers.providerFor(located.ref.scheme);
    const extracted = provider.extractFileOps(located.path, root, changedList);
    ops.push(...extracted.ops);
    if (extracted.segment) {
      segments.push({ ...located.ref, msgUuid: extracted.segment.from, rangeEnd: extracted.segment.to });
    } else {
      segments.push({ ...located.ref });
    }
  }

  const replayed = new Map();
  const baseContent = (file) => {
    if (!replayed.has(file)) {
      const blob = tryGit(root, ['show', `${baseSha}:${file}`]);
      replayed.set(file, blob ?? '');
    }
    return replayed.get(file);
  };

  for (const op of ops) {
    if (op.kind === 'patch') {
      const applied = applyPatchToReplay(replayed, baseContent, op.patch);
      if (!applied.ok) {
        unexplainedOps.push(`${op.tool} patch failed to replay${op.file ? ` (${op.file})` : ''}: ${applied.error}`);
      }
    } else if (op.tool === 'Write') {
      replayed.set(op.file, op.input.content ?? '');
    } else {
      // Edit applies one replacement; MultiEdit applies a sequence.
      const edits = op.tool === 'MultiEdit' ? op.input.edits ?? [] : [op.input];
      for (const e of edits) {
        const current = baseContent(op.file);
        const oldStr = e.old_string ?? '';
        if (oldStr === '' || !current.includes(oldStr)) {
          unexplainedOps.push(`${op.file}: ${op.tool} old_string not found during replay`);
          continue;
        }
        replayed.set(
          op.file,
          e.replace_all ? current.split(oldStr).join(e.new_string ?? '') : current.replace(oldStr, e.new_string ?? ''),
        );
      }
    }
  }

  const unexplained = [...unexplainedOps];
  for (const file of changedList) {
    if (file.startsWith('.comments/')) continue;
    const actual = tryGit(root, ['show', `${headSha}:${file}`]) ?? '';
    const expected = replayed.has(file) ? replayed.get(file) : tryGit(root, ['show', `${baseSha}:${file}`]) ?? '';
    if (actual !== expected) unexplained.push(file);
  }
  return { level: unexplained.length === 0 ? 'agent' : 'hybrid', unexplained, segments, refs };
}

// ---------- re-anchor sweep: translate anchors through the landed diff ----------

function parseHunks(diffText) {
  const hunks = [];
  for (const m of diffText.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

/** Map a 1-based line through hunks; null when the line itself was modified. */
function mapLine(hunks, line) {
  let delta = 0;
  for (const h of hunks) {
    const oldEnd = h.oldStart + Math.max(h.oldLines, 1) - 1;
    if (line < h.oldStart) break;
    if (h.oldLines > 0 && line <= oldEnd) return null; // inside a modified hunk
    delta += h.newLines - h.oldLines;
  }
  return line + delta;
}

function reanchorSweep(root, landedSha, touchedFiles, excludeThreadIds) {
  const swept = [];
  const flagged = [];
  for (const t of listThreads(root)) {
    if (t.status !== 'open' || excludeThreadIds.has(t.id) || !touchedFiles.has(t.file)) continue;
    const baseline = t.anchor.baseline;
    if (!baseline || baseline.kind !== 'commit') {
      flagged.push({ threadId: t.id, reason: 'non-commit baseline; needs manual re-anchor' });
      continue;
    }
    const diff = tryGit(root, ['diff', '--unified=0', baseline.sha, landedSha, '--', t.file]);
    if (diff === null) continue;
    const hunks = parseHunks(diff);
    const newStart = mapLine(hunks, t.anchor.start.line + 1);
    const newEnd = mapLine(hunks, t.anchor.end.line + 1);
    const landedContent = tryGit(root, ['show', `${landedSha}:${t.file}`]);
    let matches = false;
    if (newStart !== null && newEnd !== null && landedContent !== null) {
      // Reconstruct the exact span at the mapped position; it must byte-match.
      const lines = landedContent.split('\n');
      const s = newStart - 1;
      const e = newEnd - 1;
      const span =
        s === e
          ? (lines[s] ?? '').slice(t.anchor.start.char, t.anchor.end.char)
          : [(lines[s] ?? '').slice(t.anchor.start.char), ...lines.slice(s + 1, e), (lines[e] ?? '').slice(0, t.anchor.end.char)].join('\n');
      matches = span === t.anchor.text;
    }
    if (newStart !== null && newEnd !== null && matches) {
      appendEvent(root, t.id, 'reanchored', {
        anchor: {
          ...t.anchor,
          baseline: { kind: 'commit', sha: landedSha },
          start: { line: newStart - 1, char: t.anchor.start.char },
          end: { line: newEnd - 1, char: t.anchor.end.char },
        },
        method: 'diff',
      });
      swept.push(t.id);
    } else {
      appendEvent(root, t.id, 'replied', {
        commentId: `c_${crypto.randomUUID()}`,
        body: `This landing (${landedSha.slice(0, 8)}) rewrote the anchored text — please re-pin this thread.`,
      });
      flagged.push({ threadId: t.id, reason: 'anchor collided with the landed diff' });
    }
  }
  return { swept, flagged };
}

// ---------- land: the serialized pipeline ----------

function loadQueueConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.comments', 'queue.json'), 'utf8'));
  } catch {
    return {};
  }
}

function runLand(root, opts) {
  const report = { ok: false, steps: [] };
  const step = (name, detail) => {
    report.steps.push({ name, detail });
    process.stderr.write(`· ${name}${detail ? ` — ${detail}` : ''}\n`);
  };

  const lockPath = path.join(root, '.git', 'comments-queue.lock');
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch {
    throw new Error(`another landing is in flight (${lockPath} exists; remove it if stale)`);
  }

  let worktree;
  let keepWorktree = false;
  try {
    const target = opts.target || git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const targetSha = git(root, ['rev-parse', target]).trim();
    const candidateSha = git(root, ['rev-parse', opts.branch]).trim();
    report.target = target;
    report.preLandingSha = targetSha;

    // 1. Rebase in an isolated worktree.
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-queue-'));
    git(root, ['worktree', 'add', '--detach', worktree, candidateSha]);
    try {
      git(worktree, ['rebase', targetSha]);
    } catch (err) {
      if (opts.keepConflicts) {
        // Leave the conflicted rebase in place for the caller (main agent or
        // human) to resolve with full context, then resubmit the result.
        keepWorktree = true;
        const conflicted = (tryGit(worktree, ['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').filter(Boolean);
        report.error = 'rebase-conflict';
        report.conflict = {
          worktree,
          files: conflicted,
          resume: `resolve conflicts in ${worktree}, then: git -C ${worktree} rebase --continue && comments-queue land --branch $(git -C ${worktree} rev-parse HEAD) --threads ${opts.threads.join(',')}${opts.session ? ` --session ${opts.session}` : ''}; finally: git worktree remove --force ${worktree}`,
        };
        step('rebase', `CONFLICT — preserved at ${worktree}`);
        return report;
      }
      tryGit(worktree, ['rebase', '--abort']);
      throw new Error(`rebase onto ${target} failed — resolve in the candidate and resubmit (or retry with --keep-conflicts):\n${err.message}`);
    }
    let head = git(worktree, ['rev-parse', 'HEAD']).trim();
    const aheadCount = git(worktree, ['rev-list', '--count', `${targetSha}..HEAD`]).trim();
    if (aheadCount !== '1') {
      throw new Error(`candidate is ${aheadCount} commits ahead of ${target}; v1 lands single-commit candidates only`);
    }
    step('rebase', `${candidateSha.slice(0, 8)} → ${head.slice(0, 8)} on ${target}`);

    // 2. Gate: no OTHER open blocking thread on touched files. Fleet landings
    // exempt their sibling in-flight threads via opts.allow.
    const changed = new Set(git(root, ['diff', '--name-only', `${targetSha}..${head}`]).split('\n').filter(Boolean));
    const addressed = new Set([...opts.threads, ...(opts.allow || [])]);
    const gateHits = listThreads(root).filter(
      (t) => t.status === 'open' && t.severity === 'blocking' && changed.has(t.file) && !addressed.has(t.id),
    );
    if (gateHits.length > 0) {
      throw new Error(`blocked by open blocking thread(s): ${gateHits.map((t) => t.id).join(', ')}`);
    }
    step('gate', `${changed.size} file(s), 0 blocking conflicts`);

    // 3. Configured checks.
    const checks = loadQueueConfig(root).checks || [];
    for (const check of checks) {
      const res = spawnSync(check, { cwd: worktree, shell: true, encoding: 'utf8' });
      if (res.status !== 0) {
        throw new Error(`check failed: ${check}\n${(res.stdout + res.stderr).slice(-2000)}`);
      }
      step('check', check);
    }
    if (checks.length === 0) step('check', 'none configured (.comments/queue.json)');

    // 4. Provenance.
    const prov = verifyProvenance(root, targetSha, head, opts.session);
    report.provenance = prov.level;
    report.unexplained = prov.unexplained;
    step('provenance', prov.level + (prov.unexplained.length ? ` (${prov.unexplained.length} unexplained)` : ''));

    // 5. Stamp trailers and land the code commit.
    const message = git(worktree, ['log', '-1', '--format=%B']).trim();
    const sessionTrailers = prov.segments.map(
      (seg) => `Agent-Session: ${providers.formatSessionRef(seg)}`,
    );
    const trailers = [
      ...opts.threads.map((t) => `Comments-Resolves: ${t}`),
      ...sessionTrailers,
      `Provenance: ${prov.level}`,
    ];
    git(worktree, ['commit', '--amend', '-m', `${message}\n\n${trailers.join('\n')}`]);
    head = git(worktree, ['rev-parse', 'HEAD']).trim();
    git(root, ['merge', '--ff-only', head]);
    report.landedSha = head;
    step('land', head.slice(0, 8));

    // 6. Metadata commit: events, vendoring, brief, sweep, prunes.
    for (const threadId of opts.threads) {
      appendEvent(root, threadId, 'resolved', { reason: 'fixed', sha: head });
      const state = fold(threadId, readThreadEvents(root, threadId));
      for (const s of (state?.suggestions ?? []).filter((x) => x.status === 'open')) {
        appendEvent(root, threadId, 'suggestion_accepted', { suggestionId: s.id });
      }
      appendEvent(root, threadId, 'released', {});
    }
    // Vendor every cited transcript: a trailer whose session is not vendored is
    // dangling, and a fresh clone must still be able to verify what we stamped.
    for (const ref of prov.refs) {
      const located = providers.locateSession(ref, root);
      if (!located) continue;
      const dst = path.join(root, '.comments', 'sessions', `${ref.sessionId}.jsonl`);
      if (located.path !== dst) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(located.path, dst);
      }
    }
    const sweep = reanchorSweep(root, head, new Set(changed), new Set(opts.threads));
    report.reanchored = sweep.swept;
    report.flagged = sweep.flagged;

    // Prune thread files resolved before this landing (--no-prune keeps them
    // in the working tree, e.g. for demo walkthroughs; history retains either way).
    const pruned = [];
    if (!opts.noPrune) {
      for (const t of listThreads(root)) {
        if (t.status === 'resolved' && t.resolvedTs && !opts.threads.includes(t.id)) {
          fs.rmSync(path.join(root, '.comments', 'threads', `${t.id}.jsonl`), { force: true });
          pruned.push(t.id);
        }
      }
    }
    report.pruned = pruned;

    const brief = [
      `# ${head.slice(0, 12)} — landing brief`,
      '',
      `- target: ${target} (${targetSha.slice(0, 8)} → ${head.slice(0, 8)})`,
      `- threads resolved: ${opts.threads.join(', ') || 'none'}`,
      `- sessions: ${prov.segments.map((seg) => providers.formatSessionRef(seg)).join(', ') || 'none'}`,
      `- provenance: ${prov.level}`,
      ...(prov.unexplained.length ? ['- unexplained (no reasoning trace):', ...prov.unexplained.map((u) => `  - ${u}`)] : []),
      `- files: ${[...changed].join(', ')}`,
      `- re-anchored: ${sweep.swept.join(', ') || 'none'}; flagged: ${sweep.flagged.map((f) => f.threadId).join(', ') || 'none'}`,
      `- checks: ${checks.join('; ') || 'none configured'}`,
    ].join('\n');
    const briefPath = path.join(root, '.comments', 'briefs', `${head}.md`);
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(briefPath, brief + '\n');

    try {
      git(root, ['add', '.comments']);
      git(root, ['commit', '-m', `comments: metadata for ${head.slice(0, 12)}\n\nComments-Meta-For: ${head}`]);
      report.metaSha = git(root, ['rev-parse', 'HEAD']).trim();
      step('metadata', report.metaSha.slice(0, 8));
    } catch (err) {
      step('metadata', `FAILED — code commit is landed; commit .comments/ manually (${err.message.split('\n')[0]})`);
    }

    report.ok = true;
    return report;
  } finally {
    if (worktree && !keepWorktree) {
      tryGit(root, ['worktree', 'remove', '--force', worktree]);
      fs.rmSync(worktree, { recursive: true, force: true });
    }
    if (lockFd !== undefined) {
      fs.closeSync(lockFd);
      fs.rmSync(lockPath, { force: true });
    }
  }
}

// ---------- land-suggestion: package an accepted suggestion into a landing ----------

function runLandSuggestion(root, opts) {
  const events = readThreadEvents(root, opts.thread);
  const state = fold(opts.thread, events);
  if (!state) throw new Error(`thread ${opts.thread} not found`);
  const decided = new Set(
    events.filter((e) => e.type === 'suggestion_accepted' || e.type === 'suggestion_rejected').map((e) => e.suggestionId),
  );
  const sugEv = [...events].reverse().find(
    (e) => e.type === 'suggested' && typeof e.patch === 'string' && !decided.has(e.suggestionId || e.id),
  );
  if (!sugEv) throw new Error(`thread ${opts.thread} has no open suggestion`);

  const target = opts.target || git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const targetSha = git(root, ['rev-parse', target]).trim();
  const created = events.find((e) => e.type === 'created');
  const snippet = String(created?.body ?? state.id).replace(/\s+/g, ' ').trim().slice(0, 60);

  // Build the candidate in a scratch worktree — the user's tree stays clean.
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-cand-'));
  let candidateSha;
  try {
    git(root, ['worktree', 'add', '--detach', worktree, targetSha]);
    const patch = sugEv.patch.endsWith('\n') ? sugEv.patch : sugEv.patch + '\n';
    const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '--3way', '-'], {
      cwd: worktree, input: patch, encoding: 'utf8',
    });
    if (applied.status !== 0) throw new Error(`suggestion patch does not apply to ${target}: ${(applied.stderr || '').trim()}`);
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-qm', `fix: ${snippet}\n\nApplies suggestion ${sugEv.suggestionId || sugEv.id} from ${state.id}.`]);
    candidateSha = git(worktree, ['rev-parse', 'HEAD']).trim();
  } finally {
    tryGit(root, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(worktree, { recursive: true, force: true });
  }

  return runLand(root, {
    branch: candidateSha,
    threads: [opts.thread],
    session: sugEv.actor?.session,
    target: opts.target,
    allow: opts.allow,
    noPrune: opts.noPrune,
    keepConflicts: opts.keepConflicts,
  });
}

// ---------- fleet: worktree-per-fixer over claimed threads, landed serially ----------

function liveClaimOf(state) {
  const claimed = [...state.events].reverse().find((e) => e.type === 'claimed' || e.type === 'released');
  if (!claimed || claimed.type === 'released') return null;
  const ttl = typeof claimed.ttlSeconds === 'number' ? claimed.ttlSeconds : 3600;
  return Date.now() < Date.parse(claimed.ts) + ttl * 1000 ? claimed.actor : null;
}

function fleetPrompt(root, state) {
  const bodies = state.events
    .filter((e) => e.type === 'created' || e.type === 'replied')
    .map((e) => `- ${e.actor?.name ?? '?'}: ${e.body}`)
    .join('\n');
  return [
    `You are fixing a code-review comment thread in an isolated git worktree of the repository ${root}.`,
    '',
    `Thread ${state.id} — ${state.file}, lines ${state.anchor.start.line + 1}-${state.anchor.end.line + 1}.`,
    'Anchored code:',
    '```',
    state.anchor.text,
    '```',
    'Discussion:',
    bodies,
    '',
    'Instructions:',
    '1. Fix the issue by editing files in the current directory directly (Edit/Write). Do NOT run git.',
    `2. Reply via the comments MCP tool reply_to_thread (threadId "${state.id}") describing exactly what you changed and why.`,
    '3. If after investigation no code change is warranted, reply explaining why and change nothing.',
  ].join('\n');
}

async function runFleet(root, opts) {
  const claudeCmd = opts.claude || 'claude';
  const target = opts.target || git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const targetSha = git(root, ['rev-parse', target]).trim();
  const mcpServer = path.join(__dirname, 'mcp-comments.js');

  const results = [];
  const candidates = [];
  const jobs = [];
  for (const threadId of opts.threads) {
    const state = fold(threadId, readThreadEvents(root, threadId));
    if (!state || state.status !== 'open') {
      results.push({ threadId, status: 'skipped', reason: 'not found or not open' });
      continue;
    }
    const holder = liveClaimOf(state);
    if (holder && holder.kind !== 'notary') {
      results.push({ threadId, status: 'skipped', reason: `claimed by ${holder.name}` });
      continue;
    }
    appendEvent(root, threadId, 'claimed', { ttlSeconds: 3600, actor: { name: 'fleet', kind: 'agent' } });
    jobs.push({ threadId, state });
  }

  const parallel = Math.max(1, Math.min(Number(opts.parallel) || 4, jobs.length || 1));
  process.stderr.write(`· fleet: ${jobs.length} fixer(s), ${parallel} at a time, target ${target}\n`);

  let next = 0;
  async function worker() {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      const { threadId, state } = job;
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-fleet-'));
      const sessionId = crypto.randomUUID();
      try {
        git(root, ['worktree', 'add', '--detach', worktree, targetSha]);
        const mcpConfig = JSON.stringify({
          mcpServers: {
            comments: {
              command: process.execPath,
              args: [mcpServer],
              env: { MD_COMMENTS_ROOT: root, MD_COMMENTS_SESSION: sessionId },
            },
          },
        });
        const args = [
          '-p', fleetPrompt(root, state),
          '--output-format', 'stream-json', '--verbose',
          '--session-id', sessionId,
          '--mcp-config', mcpConfig,
          '--permission-mode', 'acceptEdits',
          '--allowedTools',
          ['Edit', 'Write', 'mcp__comments__get_thread', 'mcp__comments__reply_to_thread', 'mcp__comments__list_threads'].join(','),
        ];
        const code = await new Promise((resolve) => {
          const { spawn } = require('child_process');
          const proc = spawn(claudeCmd, args, {
            cwd: worktree,
            stdio: ['ignore', 'ignore', 'ignore'],
            env: { ...process.env, MD_COMMENTS_ROOT: root, MD_COMMENTS_SESSION: sessionId },
          });
          proc.on('error', () => resolve(-1));
          proc.on('close', resolve);
        });
        if (code !== 0) {
          appendEvent(root, threadId, 'released', {});
          results.push({ threadId, status: 'failed', reason: `agent exited ${code}` });
          continue;
        }
        const dirty = git(worktree, ['status', '--porcelain']).trim();
        if (!dirty) {
          appendEvent(root, threadId, 'released', {});
          results.push({ threadId, status: 'replied', reason: 'no code change produced' });
          continue;
        }
        const created = state.events.find((e) => e.type === 'created');
        const snippet = String(created?.body ?? threadId).replace(/\s+/g, ' ').trim().slice(0, 60);
        git(worktree, ['add', '-A']);
        git(worktree, ['commit', '-qm', `fix: ${snippet}`]);
        candidates.push({ threadId, sha: git(worktree, ['rev-parse', 'HEAD']).trim(), sessionId });
        process.stderr.write(`· fixer done: ${threadId}\n`);
      } catch (err) {
        appendEvent(root, threadId, 'released', {});
        results.push({ threadId, status: 'failed', reason: err.message.split('\n')[0] });
      } finally {
        tryGit(root, ['worktree', 'remove', '--force', worktree]);
        fs.rmSync(worktree, { recursive: true, force: true });
      }
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));

  // Land serially — the queue is the only serialized section.
  for (const cand of candidates) {
    try {
      const landed = runLand(root, {
        branch: cand.sha,
        threads: [cand.threadId],
        session: cand.sessionId,
        target,
        allow: opts.threads,
      });
      results.push({ threadId: cand.threadId, status: 'landed', sha: landed.landedSha, provenance: landed.provenance });
    } catch (err) {
      appendEvent(root, cand.threadId, 'released', {});
      results.push({ threadId: cand.threadId, status: 'land-failed', reason: err.message.split('\n')[0] });
    }
  }
  return { ok: results.every((r) => r.status === 'landed' || r.status === 'replied'), target, results };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[a.slice(2)] = true; // boolean flag
      else opts[a.slice(2)] = argv[++i];
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const root = resolveRoot();
  try {
    if (cmd === 'check') {
      if (!opts.base || !opts.head) throw new Error('usage: comments-queue check --base <ref> --head <ref> [--allow th_a,th_b]');
      process.exit(runCheck(root, { base: opts.base, head: opts.head, allow: opts.allow ? opts.allow.split(',') : [] }));
    } else if (cmd === 'land') {
      if (!opts.branch) throw new Error('usage: comments-queue land --branch <ref> [--threads th_a,th_b] [--session [claude:|codex:]<sid>[,<sid>…]] [--target <branch>]');
      const report = runLand(root, {
        branch: opts.branch,
        threads: opts.threads ? opts.threads.split(',') : [],
        session: opts.session,
        target: opts.target,
        noPrune: !!opts['no-prune'],
        keepConflicts: !!opts['keep-conflicts'],
      });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(report.ok ? 0 : 1);
    } else if (cmd === 'land-suggestion') {
      if (!opts.thread) throw new Error('usage: comments-queue land-suggestion --thread <th_…> [--target <branch>]');
      const report = runLandSuggestion(root, {
        thread: opts.thread,
        target: opts.target,
        noPrune: !!opts['no-prune'],
        keepConflicts: !!opts['keep-conflicts'],
      });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(report.ok ? 0 : 1);
    } else if (cmd === 'fleet') {
      if (!opts.threads) throw new Error('usage: comments-queue fleet --threads th_a,th_b [--claude <cmd>] [--parallel N] [--target <branch>]');
      const report = await runFleet(root, {
        threads: opts.threads.split(','),
        claude: opts.claude,
        parallel: opts.parallel,
        target: opts.target,
      });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(report.ok ? 0 : 1);
    } else {
      throw new Error('usage: comments-queue <check|land|land-suggestion|fleet> …');
    }
  } catch (err) {
    process.stderr.write(`comments-queue: ${err.message}\n`);
    process.exit(2);
  }
}

main();
