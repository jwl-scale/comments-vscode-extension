#!/usr/bin/env node
/**
 * MCP server exposing .comments/ threads to Claude Code (or any MCP client).
 * Zero dependencies — newline-delimited JSON-RPC 2.0 over stdio.
 *
 * Register:  claude mcp add comments -- node /path/to/bin/mcp-comments.js
 * Root:      $MD_COMMENTS_ROOT, else the client's cwd (resolved to the
 *            repository's PRIMARY working tree — worktree-safe; see
 *            docs/spec/sidecar-v2.md "Store model").
 *
 * Sidecar format v2: one append-only JSONL event log per thread under
 * `.comments/threads/<threadId>.jsonl`. This file deliberately duplicates the
 * format logic (it must run standalone, outside the extension host); the
 * contract is docs/spec/sidecar-v2.md.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const providers = require('./lib/session-providers');

const CONTEXT = 120;

// ---------- store resolution (spec "Store model") ----------

function git(cwd, args, input) {
  try {
    const res = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return res.status === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

function resolveRoot() {
  const start = path.resolve(process.env.MD_COMMENTS_ROOT || process.cwd());
  const common = git(start, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common) {
    const commonDir = common.trim();
    if (path.basename(commonDir) === '.git') return path.dirname(commonDir);
  }
  return start;
}

const ROOT = resolveRoot();
const THREADS_DIR = path.join(ROOT, '.comments', 'threads');
const GITATTRIBUTES_LINE = '.comments/threads/*.jsonl merge=union';

// ---------- event log: parse / fold / locked append ----------

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
      continue; // torn tail line
    }
    if (!ev || typeof ev.id !== 'string' || typeof ev.type !== 'string' || seen.has(ev.id)) continue;
    seen.add(ev.id);
    events.push(ev);
  }
  return events.sort(
    (a, b) => (a.seq || 0) - (b.seq || 0) || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) || (a.id < b.id ? -1 : 1),
  );
}

function readLog(p) {
  try {
    return parseLog(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
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
    comments: [],
    suggestions: [],
    claim: null,
  };
  const byId = new Map();
  for (const ev of events) {
    switch (ev.type) {
      case 'created':
      case 'replied': {
        const c = {
          id: ev.commentId || ev.id,
          author: (ev.actor && ev.actor.name) || 'unknown',
          body: ev.body || '',
          createdAt: ev.ts,
          deleted: false,
        };
        byId.set(c.id, c);
        state.comments.push(c);
        break;
      }
      case 'edited': {
        const t = byId.get(ev.commentId);
        if (t) t.body = ev.body != null ? ev.body : t.body;
        break;
      }
      case 'comment_deleted': {
        const t = byId.get(ev.commentId);
        if (t) t.deleted = true;
        break;
      }
      case 'resolved':
        state.status = 'resolved';
        break;
      case 'reopened':
        state.status = 'open';
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
      case 'claimed':
        state.claim = { actor: ev.actor, ts: ev.ts, ttlSeconds: typeof ev.ttlSeconds === 'number' ? ev.ttlSeconds : 3600 };
        break;
      case 'released':
        if (state.claim && state.claim.actor && state.claim.actor.name === (ev.actor && ev.actor.name)) state.claim = null;
        break;
      case 'suggested':
        if (typeof ev.patch === 'string') {
          state.suggestions.push({
            id: ev.suggestionId || ev.id,
            patch: ev.patch,
            author: (ev.actor && ev.actor.name) || 'unknown',
            status: 'open',
          });
        }
        break;
      case 'suggestion_accepted':
      case 'suggestion_rejected': {
        const s = state.suggestions.find((x) => x.id === ev.suggestionId);
        if (s) s.status = ev.type === 'suggestion_accepted' ? 'accepted' : 'rejected';
        break;
      }
    }
  }
  state.comments = state.comments.filter((c) => !c.deleted);
  return state.comments.length > 0 ? state : null;
}

function liveClaim(state) {
  const c = state.claim;
  if (!c) return null;
  return Date.now() < Date.parse(c.ts) + c.ttlSeconds * 1000 ? c : null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Serialized append per spec: lock → read tail for seq → one-line append → unlock. */
function appendEvent(logPath, actor, type, fields) {
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
    const seq = readLog(logPath).reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
    const event = Object.assign(
      { id: `ev_${crypto.randomUUID()}`, type, seq, ts: new Date().toISOString(), actor },
      fields,
    );
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
    return event;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

function threadPath(threadId) {
  if (!/^th_[A-Za-z0-9-]+$/.test(threadId)) throw new Error(`invalid thread id: ${threadId}`);
  return path.join(THREADS_DIR, `${threadId}.jsonl`);
}

function listThreadStates() {
  if (!fs.existsSync(THREADS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(THREADS_DIR)) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    const state = fold(id, readLog(path.join(THREADS_DIR, name)));
    if (state) out.push(state);
  }
  return out;
}

function getThreadState(threadId) {
  const p = threadPath(threadId);
  if (!fs.existsSync(p)) throw new Error(`thread ${threadId} not found`);
  const state = fold(threadId, readLog(p));
  if (!state) throw new Error(`thread ${threadId} is empty or unreadable`);
  return state;
}

function agentActor(author) {
  // MD_COMMENTS_AUTHOR is set for dispatched workers so their events are
  // attributed to the dispatched agent name (e.g. "reviewer"), not "claude".
  const envAuthor = process.env.MD_COMMENTS_AUTHOR;
  const name = author || envAuthor || 'claude';
  const kind = author && author !== 'claude' && author !== envAuthor ? 'human' : 'agent';
  const actor = { name, kind };
  // Stamps every event this server writes with the driving session, so each
  // agent reply carries its own provenance chip.
  const session = currentSessionRef();
  if (session) actor.session = session;
  return actor;
}

/**
 * The driving session, resolved at WRITE time rather than at startup.
 *
 * Claude can be handed a session id up front (`--session-id`), so the runner
 * sets MD_COMMENTS_SESSION before spawning and we are done. Codex cannot: its
 * id only exists once the process announces `thread.started`, which is after
 * this server has already been spawned. For that case the runner passes
 * MD_COMMENTS_SESSION_FILE — a path it fills in the moment the id appears on
 * the event stream — and we re-read it per write.
 *
 * Re-reading is what makes late binding work; caching would freeze in the
 * empty state the file has for the first few hundred milliseconds of a run.
 * The file is tiny and writes are already doing thread IO under a lock.
 */
function currentSessionRef() {
  if (process.env.MD_COMMENTS_SESSION) return process.env.MD_COMMENTS_SESSION;
  const file = process.env.MD_COMMENTS_SESSION_FILE;
  if (!file) return undefined;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    // Only accept something that parses as a ref: a half-written file must not
    // be stamped onto an event we can never take back.
    return raw && providers.parseSessionRef(raw) ? raw : undefined;
  } catch {
    return undefined; // not written yet — the run has not announced its id
  }
}

function threadSummary(t) {
  const claim = liveClaim(t);
  return {
    threadId: t.id,
    file: t.file,
    status: t.status,
    severity: t.severity,
    startLine: t.anchor.start.line + 1,
    endLine: t.anchor.end.line + 1,
    anchorText: t.anchor.text,
    claimedBy: claim ? claim.actor.name : undefined,
    suggestions: t.suggestions.map((s) => ({ suggestionId: s.id, author: s.author, status: s.status })),
    comments: t.comments.map((c) => ({ author: c.author, body: c.body, createdAt: c.createdAt })),
  };
}

// ---------- baselines (spec "Anchors") ----------

function gitBlobSha(content) {
  const buf = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function captureBaseline(relFile, content) {
  const head = git(ROOT, ['rev-parse', 'HEAD']);
  if (!head) return null;
  const status = git(ROOT, ['status', '--porcelain', '--', relFile]);
  const tracked = git(ROOT, ['ls-files', '--error-unmatch', '--', relFile]);
  if (tracked !== null && status !== null && status.trim() === '') {
    if (git(ROOT, ['show', `HEAD:${relFile}`]) === content) {
      return { kind: 'commit', sha: head.trim() };
    }
  }
  const written = git(ROOT, ['hash-object', '-w', '--stdin'], content);
  return { kind: 'blob', sha: written ? written.trim() : gitBlobSha(content), commit: head.trim() };
}

/** A vendored transcript's scheme is not in its filename — recover it from content. */
function vendoredSessionRef(sessionId) {
  const file = path.join(ROOT, '.comments', 'sessions', `${sessionId}.jsonl`);
  return `${providers.sniffScheme(file)}:${sessionId}`;
}

/** Parse trailer lines (Key: value) from a commit message's final paragraph. */
function parseTrailers(message) {
  const out = { threads: [], resolves: [], sessions: [], session: null, provenance: null, metaFor: null };
  for (const line of message.split('\n')) {
    let m;
    if ((m = line.match(/^Comments-Thread:\s*(\S+)/))) out.threads.push(m[1]);
    else if ((m = line.match(/^Comments-Resolves:\s*(\S+)/))) out.resolves.push(m[1]);
    // Agent-Session is repeatable and scheme-qualified; Claude-Session is its
    // pre-v0.12 spelling, read as scheme `claude` (docs/spec/commit-trailers.md).
    else if ((m = line.match(/^(?:Agent|Claude)-Session:\s*(\S+)/))) {
      const ref = providers.parseSessionRef(m[1]);
      if (ref) out.sessions.push(providers.formatSessionRef(ref));
    } else if ((m = line.match(/^Provenance:\s*(\S+)/))) out.provenance = m[1];
    else if ((m = line.match(/^Comments-Meta-For:\s*(\S+)/))) out.metaFor = m[1];
  }
  // Back-compat for single-session consumers.
  out.session = out.sessions[0] ?? null;
  return out;
}

function ensureGitattributes() {
  const p = path.join(ROOT, '.gitattributes');
  try {
    const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (current.includes(GITATTRIBUTES_LINE)) return;
    fs.writeFileSync(p, current + (current && !current.endsWith('\n') ? '\n' : '') + GITATTRIBUTES_LINE + '\n');
  } catch {
    /* non-fatal */
  }
}

/** Anchor computation shared by create_thread and re_anchor_thread. */
function computeAnchor(args) {
  const abs = path.resolve(ROOT, args.file);
  if (!abs.startsWith(ROOT + path.sep)) throw new Error('file escapes workspace');
  if (!fs.existsSync(abs)) throw new Error(`${args.file} does not exist`);
  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split('\n');

  let startOff, endOff;
  if (args.anchorText) {
    const idx = content.indexOf(args.anchorText);
    if (idx === -1) throw new Error('anchorText not found verbatim in file');
    startOff = idx;
    endOff = idx + args.anchorText.length;
  } else if (args.startLine) {
    const s = Math.max(1, args.startLine) - 1;
    const e = Math.min(lines.length, args.endLine || args.startLine) - 1;
    startOff = lines.slice(0, s).reduce((n, l) => n + l.length + 1, 0);
    endOff = lines.slice(0, e).reduce((n, l) => n + l.length + 1, 0) + lines[e].length;
  } else {
    throw new Error('provide anchorText or startLine');
  }

  const toPos = (off) => {
    let line = 0,
      consumed = 0;
    while (line < lines.length && consumed + lines[line].length + 1 <= off) {
      consumed += lines[line].length + 1;
      line++;
    }
    return { line, char: off - consumed };
  };
  const rel = args.file.split(path.sep).join('/');
  return {
    rel,
    anchor: {
      baseline: captureBaseline(rel, content),
      start: toPos(startOff),
      end: toPos(endOff),
      text: content.slice(startOff, endOff),
      prefix: content.slice(Math.max(0, startOff - CONTEXT), startOff),
      suffix: content.slice(endOff, endOff + CONTEXT),
    },
  };
}

// ---------- tools ----------

const TOOLS = [
  {
    name: 'list_threads',
    description:
      'List comment threads in this repo. Threads anchor to text ranges in source files; bodies may contain file:line refs and claude:<sessionId> conversation refs. Returns threadId, file, 1-based line range, anchored text, status, and all comments.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Only threads on this workspace-relative file' },
        status: { type: 'string', enum: ['open', 'resolved'], description: 'Filter by status' },
      },
    },
    handler: (args) =>
      listThreadStates()
        .filter((t) => (!args.file || t.file === args.file) && (!args.status || t.status === args.status))
        .map(threadSummary),
  },
  {
    name: 'get_thread',
    description: 'Get one comment thread by threadId, including its anchor and full comment history.',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId'],
    },
    handler: (args) => threadSummary(getThreadState(args.threadId)),
  },
  {
    name: 'reply_to_thread',
    description:
      'Append a reply to an existing comment thread. Use file:line refs (e.g. src/foo.ts:12-34) and claude:<sessionId>#<msgUuid> refs in the body — the extension renders them as deeplinks.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        body: { type: 'string' },
        author: { type: 'string', description: 'Defaults to "claude"' },
      },
      required: ['threadId', 'body'],
    },
    handler: (args) => {
      const state = getThreadState(args.threadId);
      appendEvent(threadPath(args.threadId), agentActor(args.author), 'replied', {
        commentId: `c_${crypto.randomUUID()}`,
        body: args.body,
      });
      return threadSummary(getThreadState(state.id));
    },
  },
  {
    name: 'resolve_thread',
    description:
      'Set a comment thread status to resolved (or back to open). Optionally give a reason: fixed | stale | wontfix | obsolete.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        status: { type: 'string', enum: ['open', 'resolved'], description: 'Defaults to resolved' },
        reason: {
          type: 'string',
          enum: ['fixed', 'stale', 'wontfix', 'obsolete'],
          description: 'Why it is resolved (default fixed)',
        },
        author: { type: 'string', description: 'Defaults to "claude"' },
      },
      required: ['threadId'],
    },
    handler: (args) => {
      const state = getThreadState(args.threadId);
      const want = args.status || 'resolved';
      if (state.status === want) return threadSummary(state); // idempotent — no duplicate events
      const actor = agentActor(args.author);
      if (want === 'resolved') {
        appendEvent(threadPath(state.id), actor, 'resolved', { reason: args.reason || 'fixed' });
      } else {
        appendEvent(threadPath(state.id), actor, 'reopened', {});
      }
      return threadSummary(getThreadState(state.id));
    },
  },
  {
    name: 'create_thread',
    description:
      'Create a new comment thread on a file. Anchor it by exact text (anchorText, preferred — must appear verbatim in the file) or by 1-based startLine/endLine.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Workspace-relative path' },
        body: { type: 'string' },
        anchorText: { type: 'string', description: 'Exact text in the file to anchor to' },
        startLine: { type: 'number', description: '1-based, used when anchorText is omitted' },
        endLine: { type: 'number', description: '1-based, inclusive' },
        author: { type: 'string', description: 'Defaults to "claude"' },
        severity: { type: 'string', enum: ['normal', 'blocking'], description: 'Defaults to normal' },
      },
      required: ['file', 'body'],
    },
    handler: (args) => {
      ensureGitattributes();
      const { rel, anchor } = computeAnchor(args);
      const threadId = `th_${crypto.randomUUID()}`;
      appendEvent(threadPath(threadId), agentActor(args.author), 'created', {
        version: 2,
        file: rel,
        anchor,
        body: args.body,
        commentId: `c_${crypto.randomUUID()}`,
        severity: args.severity === 'blocking' ? 'blocking' : 'normal',
      });
      return threadSummary(getThreadState(threadId));
    },
  },
  {
    name: 'claim_thread',
    description:
      'Take an advisory lease on a thread before working on it (dedup across uncoordinated actors — at most one active fixer per thread). Fails if another actor holds a live claim.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        ttlSeconds: { type: 'number', description: 'Lease duration; defaults to 3600' },
        author: { type: 'string', description: 'Defaults to "claude"' },
      },
      required: ['threadId'],
    },
    handler: (args) => {
      const state = getThreadState(args.threadId);
      const actor = agentActor(args.author);
      const existing = liveClaim(state);
      if (existing && existing.actor.name !== actor.name) {
        throw new Error(`thread is claimed by ${existing.actor.name} until the lease expires`);
      }
      appendEvent(threadPath(state.id), actor, 'claimed', { ttlSeconds: args.ttlSeconds || 3600 });
      return threadSummary(getThreadState(state.id));
    },
  },
  {
    name: 'release_thread',
    description: 'Release your advisory claim on a thread (done or giving up).',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        author: { type: 'string', description: 'Defaults to "claude"' },
      },
      required: ['threadId'],
    },
    handler: (args) => {
      const state = getThreadState(args.threadId);
      appendEvent(threadPath(state.id), agentActor(args.author), 'released', {});
      return threadSummary(getThreadState(state.id));
    },
  },
  {
    name: 'set_severity',
    description: 'Set thread severity: blocking threads gate merges of files they anchor to; normal threads do not.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        severity: { type: 'string', enum: ['normal', 'blocking'] },
        author: { type: 'string', description: 'Defaults to "claude"' },
      },
      required: ['threadId', 'severity'],
    },
    handler: (args) => {
      const state = getThreadState(args.threadId);
      appendEvent(threadPath(state.id), agentActor(args.author), 'severity_changed', { severity: args.severity });
      return threadSummary(getThreadState(state.id));
    },
  },
  {
    name: 'attach_suggestion',
    description:
      'Attach a suggested change (unified diff patch, as produced by `git diff`) to a thread. A human reviews and accepts/rejects it in the editor; do not modify the working tree yourself when suggesting.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        patch: { type: 'string', description: 'Unified diff, git-style paths (a/…, b/…)' },
        author: { type: 'string', description: 'Defaults to "claude"' },
      },
      required: ['threadId', 'patch'],
    },
    handler: (args) => {
      const state = getThreadState(args.threadId);
      const head = git(ROOT, ['rev-parse', 'HEAD']);
      appendEvent(threadPath(state.id), agentActor(args.author), 'suggested', {
        suggestionId: `s_${crypto.randomUUID()}`,
        patch: args.patch,
        baseline: head ? { kind: 'commit', sha: head.trim() } : null,
      });
      return threadSummary(getThreadState(state.id));
    },
  },
  {
    name: 'get_commit_context',
    description:
      'Blame-indexed institutional memory: given a commit sha (e.g. from `git blame` on a line you are about to change), return the reasoning behind it — commit trailers (threads resolved, session segment, verified provenance), the landing brief, and summaries of the threads it addressed (recovered from git history when pruned). Use before modifying code you did not write.',
    inputSchema: {
      type: 'object',
      properties: { sha: { type: 'string', description: 'Commit sha (any unambiguous prefix)' } },
      required: ['sha'],
    },
    handler: (args) => {
      const full = git(ROOT, ['rev-parse', args.sha]);
      if (!full) throw new Error(`unknown commit: ${args.sha}`);
      const sha = full.trim();
      const message = (git(ROOT, ['show', '-s', '--format=%B', sha]) ?? '').trim();
      const trailers = parseTrailers(message);
      let brief = null;
      const briefPath = path.join(ROOT, '.comments', 'briefs', `${sha}.md`);
      if (fs.existsSync(briefPath)) brief = fs.readFileSync(briefPath, 'utf8');
      else {
        // Briefs land in the FOLLOWING metadata commit; recover from history.
        const rev = (git(ROOT, ['rev-list', '--all', '-1', '--', `.comments/briefs/${sha}.md`]) ?? '').trim();
        if (rev) brief = git(ROOT, ['show', `${rev}:.comments/briefs/${sha}.md`]);
      }
      const threads = [...trailers.resolves, ...trailers.threads].map((id) => {
        const p = path.join(THREADS_DIR, `${id}.jsonl`);
        let events = fs.existsSync(p) ? readLog(p) : [];
        if (events.length === 0) {
          const rev = (git(ROOT, ['rev-list', '--all', '-1', '--', `.comments/threads/${id}.jsonl`]) ?? '').trim();
          const content = rev ? git(ROOT, ['show', `${rev}:.comments/threads/${id}.jsonl`]) : null;
          if (content) events = parseLog(content);
        }
        const state = fold(id, events);
        return state
          ? { threadId: id, file: state.file, status: state.status, comments: state.comments.map((c) => ({ author: c.author, body: c.body })) }
          : { threadId: id, missing: true };
      });
      return {
        sha,
        subject: message.split('\n')[0],
        provenance: trailers.provenance ?? 'human',
        session: trailers.session,
        metaFor: trailers.metaFor,
        threads,
        brief,
      };
    },
  },
  {
    name: 'search_reasoning',
    description:
      'Search the repo’s recorded reasoning — landing briefs, comment-thread discussions, and vendored Claude session transcripts — for a phrase. Returns matching sources with snippets; follow up with get_commit_context / get_thread / the claude: session ref. Causal retrieval: results are linked to the commits and conversations that produced the code.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: 'Max matches (default 10)' },
      },
      required: ['query'],
    },
    handler: (args) => {
      const q = args.query.toLowerCase();
      const limit = args.limit || 10;
      const matches = [];
      const snip = (line) => line.trim().slice(0, 200);
      const briefsDir = path.join(ROOT, '.comments', 'briefs');
      if (fs.existsSync(briefsDir)) {
        for (const name of fs.readdirSync(briefsDir)) {
          const text = fs.readFileSync(path.join(briefsDir, name), 'utf8');
          for (const line of text.split('\n')) {
            if (line.toLowerCase().includes(q)) {
              matches.push({ source: 'brief', sha: name.replace(/\.md$/, ''), snippet: snip(line) });
              break;
            }
          }
          if (matches.length >= limit) return matches;
        }
      }
      for (const t of listThreadStates()) {
        for (const c of t.comments) {
          if (c.body.toLowerCase().includes(q)) {
            matches.push({ source: 'thread', threadId: t.id, file: t.file, snippet: snip(c.body) });
            break;
          }
        }
        if (matches.length >= limit) return matches;
      }
      const sessionsDir = path.join(ROOT, '.comments', 'sessions');
      if (fs.existsSync(sessionsDir)) {
        for (const name of fs.readdirSync(sessionsDir)) {
          if (!name.endsWith('.jsonl')) continue;
          for (const line of fs.readFileSync(path.join(sessionsDir, name), 'utf8').split('\n')) {
            const idx = line.toLowerCase().indexOf(q);
            if (idx !== -1) {
              matches.push({
                source: 'session',
                ref: vendoredSessionRef(name.replace(/\.jsonl$/, '')),
                snippet: snip(line.slice(Math.max(0, idx - 60), idx + 140)),
              });
              break;
            }
          }
          if (matches.length >= limit) return matches;
        }
      }
      return matches;
    },
  },
  {
    name: 'register_session',
    description:
      'Register a working session (main orchestrator, reviewer, implementer — autonomous or human-driven) in the machine-local presence registry so humans can watch it live in the editor (Agent Sessions view → conversation graph). Presence, not history: stored under .git/, never committed. Re-register to update the mission/status; liveness is derived from transcript activity.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description:
            'Your agent session id, optionally scheme-qualified (claude:<sid> / codex:<sid>; bare means claude). Defaults to the driving session ($MD_COMMENTS_SESSION, or $MD_COMMENTS_SESSION_FILE once the run announces its id).',
        },
        role: { type: 'string', description: 'e.g. main, reviewer, implementer' },
        mission: { type: 'string', description: 'One line: what this session is working on' },
        status: { type: 'string', description: 'Optional short status update' },
      },
      required: ['role'],
    },
    handler: (args) => {
      const rawSession = args.sessionId || currentSessionRef();
      if (!rawSession) throw new Error('provide sessionId (or run with MD_COMMENTS_SESSION set)');
      const ref = providers.parseSessionRef(rawSession);
      if (!ref) throw new Error(`unrecognized session ref: ${rawSession}`);
      const sessionId = ref.sessionId;
      const common = git(ROOT, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (!common) throw new Error('not a git repository — no presence registry available');
      const runsDir = path.join(common.trim(), 'comments-runs');
      fs.mkdirSync(runsDir, { recursive: true });
      // Locate the live transcript so viewers can open (and re-vendor) it.
      const located = providers.locateSession(ref, ROOT);
      const transcriptPath = located ? located.path : null;
      const existing = (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(runsDir, `${sessionId}.json`), 'utf8'));
        } catch {
          return {};
        }
      })();
      const run = {
        sessionId,
        scheme: ref.scheme,
        role: args.role,
        mission: args.mission ?? existing.mission ?? '',
        status: args.status ?? existing.status ?? '',
        startedAt: existing.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        transcriptPath,
        root: ROOT,
      };
      fs.writeFileSync(path.join(runsDir, `${sessionId}.json`), JSON.stringify(run, null, 2) + '\n');
      return { registered: true, sessionId, scheme: ref.scheme, runsDir };
    },
  },
  {
    name: 'dispatch_agent',
    description:
      'Dispatch a configured Claude Code worker on a thread (suggest-only: it investigates read-only, replies via reply_to_thread, and attaches code changes with attach_suggestion). Takes an advisory claim, spawns headless, and returns the sessionId immediately — observe progress via the thread’s events (get_thread) and vendored transcripts. Full run configuration is exposed: model, effort, permission mode, system prompt, tools, session mode.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        instructions: { type: 'string', description: 'Extra task-specific guidance appended to the worker prompt' },
        diff: {
          type: 'string',
          description: 'Unified diff of the candidate under review — ALWAYS include this when asking for a review of uncommitted or worktree work, so the reviewer can actually see the change.',
        },
        model: { type: 'string', description: 'e.g. fable, opus, sonnet, haiku, or a full model id' },
        effort: { type: 'string', enum: ['low', 'medium', 'high'] },
        permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan'], description: 'default keeps the run suggest-only' },
        systemPrompt: { type: 'string', description: 'Replaces the base system prompt (--system-prompt)' },
        appendSystemPrompt: { type: 'string' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: 'Defaults to the comments MCP toolset' },
        maxTurns: { type: 'number' },
        sessionMode: { type: 'string', enum: ['fresh', 'continue'], description: 'continue resumes the thread’s last agent session' },
        agentName: { type: 'string', description: 'Actor name for events (defaults to "claude")' },
        command: { type: 'string', description: 'CLI to run (defaults to $MD_COMMENTS_CLAUDE or "claude")' },
      },
      required: ['threadId'],
    },
    handler: (args) => {
      const state = getThreadState(args.threadId);
      const actorName = args.agentName || 'claude';
      const existing = liveClaim(state);
      if (existing && existing.actor.name !== actorName) {
        // Dispatching is an act of orchestration authority: agent-held claims
        // (typically the dispatcher's own) hand off to the worker. Human
        // claims are never overridden.
        if (existing.actor.kind === 'human') {
          throw new Error(`thread is claimed by ${existing.actor.name} (human) — not overriding`);
        }
        appendEvent(threadPath(state.id), existing.actor, 'released', {});
      }

      // Session: fresh (preset id) or continue the thread's last agent session.
      let sessionId = crypto.randomUUID();
      let resume;
      if (args.sessionMode === 'continue') {
        const events = readLog(threadPath(state.id));
        for (let i = events.length - 1; i >= 0; i--) {
          const s = events[i].actor && events[i].actor.session;
          if (s) {
            resume = s;
            sessionId = s;
            break;
          }
        }
      }

      appendEvent(threadPath(state.id), { name: actorName, kind: 'agent' }, 'claimed', { ttlSeconds: 3600 });

      const prompt = [
        `You are addressing a code-review comment thread in the repository at ${ROOT}.`,
        '',
        `Thread ${state.id} — ${state.file}, lines ${state.anchor.start.line + 1}-${state.anchor.end.line + 1} (severity: ${state.severity}).`,
        'Anchored code:',
        '```',
        state.anchor.text,
        '```',
        'Discussion so far:',
        state.comments.map((c) => `- ${c.author} (${c.createdAt}): ${c.body}`).join('\n'),
        '',
        'Instructions:',
        `1. Investigate the surrounding code with read-only tools before answering.`,
        `2. Reply via reply_to_thread (threadId "${state.id}") — be substantive.`,
        `3. If a code change is warranted, attach it as a unified diff via attach_suggestion; do NOT modify the working tree unless your permission mode allows it and the dispatcher asked for direct edits.`,
        `4. Only resolve_thread (reason "fixed") if your reply fully addresses the comment.`,
        ...(args.instructions ? ['', `Additional instructions from your dispatcher: ${args.instructions}`] : []),
        ...(args.diff ? ['', 'The candidate change under review (unified diff):', '```diff', args.diff, '```'] : []),
      ].join('\n');

      const mcpConfig = JSON.stringify({
        mcpServers: {
          comments: {
            command: process.execPath,
            args: [__filename],
            env: { MD_COMMENTS_ROOT: ROOT, MD_COMMENTS_SESSION: sessionId, MD_COMMENTS_AUTHOR: actorName },
          },
        },
      });
      // Workers must be able to SEE code: read-only file tools plus read-only
      // git (a reviewer that cannot read the diff can only rubber-stamp).
      const DEFAULT_TOOLS = [
        'Read', 'Grep', 'Glob',
        'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git log:*)', 'Bash(git blame:*)',
        'mcp__comments__list_threads', 'mcp__comments__get_thread', 'mcp__comments__reply_to_thread',
        'mcp__comments__resolve_thread', 'mcp__comments__attach_suggestion', 'mcp__comments__set_severity',
        'mcp__comments__re_anchor_thread',
      ];
      const cliArgs = [
        '-p', prompt,
        '--output-format', 'json',
        '--mcp-config', mcpConfig,
        '--allowedTools', (args.allowedTools && args.allowedTools.length ? args.allowedTools : DEFAULT_TOOLS).join(','),
      ];
      if (resume) cliArgs.push('--resume', resume);
      else cliArgs.push('--session-id', sessionId);
      if (args.model) cliArgs.push('--model', args.model);
      if (args.effort) cliArgs.push('--effort', args.effort);
      if (args.permissionMode && args.permissionMode !== 'default') cliArgs.push('--permission-mode', args.permissionMode);
      if (args.maxTurns) cliArgs.push('--max-turns', String(args.maxTurns));
      if (args.systemPrompt) cliArgs.push('--system-prompt', args.systemPrompt);
      if (args.appendSystemPrompt) cliArgs.push('--append-system-prompt', args.appendSystemPrompt);

      const command = args.command || process.env.MD_COMMENTS_CLAUDE || 'claude';
      const { spawn } = require('child_process');
      const proc = spawn(command, cliArgs, { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
      proc.on('error', () => {
        appendEvent(threadPath(state.id), { name: actorName, kind: 'agent' }, 'released', {});
      });
      proc.on('close', (code) => {
        if (code !== 0) {
          appendEvent(threadPath(state.id), { name: actorName, kind: 'agent', session: sessionId }, 'replied', {
            commentId: `c_${crypto.randomUUID()}`,
            body: `Dispatched agent run failed (exit ${code}). Partial conversation: claude:${sessionId}`,
          });
        }
        appendEvent(threadPath(state.id), { name: actorName, kind: 'agent' }, 'released', {});
      });

      return { dispatched: true, threadId: state.id, sessionId, pid: proc.pid, mode: resume ? 'continue' : 'fresh' };
    },
  },
  {
    name: 're_anchor_thread',
    description:
      'Re-pin an orphaned or drifted thread to its current home: give the exact text (anchorText) or 1-based line range in the (possibly different) file. Use after code moved enough that the original anchor no longer resolves.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        file: { type: 'string', description: 'Defaults to the thread’s current file' },
        anchorText: { type: 'string' },
        startLine: { type: 'number', description: '1-based, used when anchorText is omitted' },
        endLine: { type: 'number', description: '1-based, inclusive' },
        author: { type: 'string', description: 'Defaults to "claude"' },
      },
      required: ['threadId'],
    },
    handler: (args) => {
      const state = getThreadState(args.threadId);
      const { rel, anchor } = computeAnchor({ ...args, file: args.file || state.file });
      const actor = agentActor(args.author);
      if (rel !== state.file) appendEvent(threadPath(state.id), actor, 'renamed', { file: rel });
      appendEvent(threadPath(state.id), actor, 'reanchored', { anchor, method: 'manual' });
      return threadSummary(getThreadState(state.id));
    },
  },
];

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(req) {
  const { id, method, params } = req;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (message, code = -32000) =>
    id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      reply({
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'anchored-comments', version: '1.1.1' },
      });
      break;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      break;
    case 'ping':
      reply({});
      break;
    case 'tools/list':
      reply({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      break;
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(`unknown tool ${params.name}`, -32602);
      try {
        const result = tool.handler(params.arguments || {});
        reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
      break;
    }
    default:
      fail(`method not found: ${method}`, -32601);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore malformed input */
    }
  }
});
process.stdin.on('end', () => process.exit(0));
