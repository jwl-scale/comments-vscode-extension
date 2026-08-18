/**
 * Agent-session providers (docs/spec/session-providers.md).
 *
 * Three concerns, and the only places a coding agent's identity leaks into the
 * system: LOCATE a session's transcript, NAME it (scheme:id refs), and EXTRACT
 * the file mutations it performed. Everything else — anchors, event logs, the
 * gate, landing, re-anchoring — is provider-independent.
 *
 * Plain JS, node builtins only, on purpose: required by both bin/comments-queue.js
 * (the notary) and bin/mcp-comments.js (the MCP server), each of which runs under
 * plain `node` outside the extension host. Mirrored by src/sessionProviders.ts for
 * the extension side; see CLAUDE.md on the deliberate duplication.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMES = ['claude', 'codex', 'cursor'];
const SESSION_REF =
  /^(?:([a-z][a-z0-9-]{0,15}):)?([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+)(?:\.\.([A-Za-z0-9_-]+))?|@([A-Za-z0-9_-]+))?$/;

/**
 * Parse a ref from a structured position (trailer value, actor.session).
 * An absent scheme means `claude` — the rule that keeps pre-v0.12 refs valid.
 * Unknown schemes return null: a provider must never guess at another's ids.
 */
function parseSessionRef(raw) {
  if (typeof raw !== 'string') return null;
  const m = SESSION_REF.exec(raw.trim());
  if (!m) return null;
  const scheme = m[1] || 'claude';
  if (!SCHEMES.includes(scheme)) return null;
  return {
    scheme,
    sessionId: m[2],
    msgUuid: m[3] || undefined,
    rangeEnd: m[4] || undefined,
    agentId: m[5] || undefined,
  };
}

/** Always scheme-qualified — writers MUST emit the scheme (spec). */
function formatSessionRef(ref) {
  const suffix = ref.agentId
    ? `@${ref.agentId}`
    : ref.msgUuid
      ? ref.rangeEnd
        ? `#${ref.msgUuid}..${ref.rangeEnd}`
        : `#${ref.msgUuid}`
      : '';
  return `${ref.scheme}:${ref.sessionId}${suffix}`;
}

// ---------- shared helpers ----------

/** Vendored transcripts are the archival record: a fresh clone must still verify. */
function vendored(root, sessionId) {
  const p = path.join(root, '.comments', 'sessions', `${sessionId}.jsonl`);
  return fs.existsSync(p) ? p : null;
}

function readJsonl(file) {
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* tolerate a torn final line — sidecar-v2 reader rule */
    }
  }
  return out;
}

/**
 * Map a transcript-recorded absolute path to a root-relative one.
 * Agents routinely work in isolated worktrees whose absolute paths differ from
 * the landing root, so fall back to a UNIQUE suffix match against the
 * candidate's changed files. Ambiguous or unmatched ⇒ null (drop the op, which
 * makes the landing verify `hybrid`). Never guess.
 */
function mapToRoot(recorded, root, changedFiles) {
  let rel = recorded;
  if (path.isAbsolute(rel)) rel = path.relative(root, rel);
  rel = rel.split(path.sep).join('/');
  if (!rel.startsWith('..')) return rel;
  const posixAbs = recorded.split(path.sep).join('/');
  const matches = (changedFiles || []).filter((f) => posixAbs.endsWith('/' + f));
  return matches.length === 1 ? matches[0] : null;
}

// ---------- provider: claude ----------

const claudeProvider = {
  scheme: 'claude',

  locate(sessionId, root) {
    const v = vendored(root, sessionId);
    if (v) return v;
    const projects = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projects)) return null;
    let slugs;
    try {
      slugs = fs.readdirSync(projects);
    } catch {
      return null;
    }
    for (const slug of slugs) {
      const p = path.join(projects, slug, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
    return null;
  },

  /**
   * A session's mutations may live in SUBAGENT transcripts (Task-tool workers
   * write to <sid>/subagents/agent-*.jsonl) — merge them all, ordered by
   * timestamp, so delegated edits verify as agent rather than hybrid.
   */
  extractFileOps(sessionFile, root, changedFiles = []) {
    const sid = path.basename(sessionFile, '.jsonl');
    const files = [{ p: sessionFile, main: true }];
    const subDir = path.join(path.dirname(sessionFile), sid, 'subagents');
    if (fs.existsSync(subDir)) {
      for (const n of fs.readdirSync(subDir)) {
        if (n.endsWith('.jsonl')) files.push({ p: path.join(subDir, n), main: false });
      }
    }

    const entries = [];
    for (const f of files) {
      for (const entry of readJsonl(f.p)) entries.push({ entry, main: f.main });
    }
    entries.sort((a, b) =>
      String(a.entry.timestamp ?? '').localeCompare(String(b.entry.timestamp ?? '')),
    );

    const ops = [];
    let firstUuid;
    let lastUuid;
    for (const { entry, main } of entries) {
      const content = entry && entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (!c || c.type !== 'tool_use') continue;
        let op;
        if (/^(Edit|Write|MultiEdit)$/.test(c.name || '') && c.input && c.input.file_path) {
          const rel = mapToRoot(c.input.file_path, root, changedFiles);
          if (rel === null) continue;
          op = { kind: 'content', tool: c.name, file: rel, input: c.input };
        } else if (/attach_suggestion$/.test(c.name || '') && typeof (c.input || {}).patch === 'string') {
          // Suggest-only agents mutate nothing; their patch IS the change.
          op = { kind: 'patch', tool: 'suggestion', patch: c.input.patch };
        } else {
          continue;
        }
        ops.push(op);
        // Segment refs must be MAIN-transcript uuids — that's what deeplinks resolve.
        if (main && typeof entry.uuid === 'string') {
          if (!firstUuid) firstUuid = entry.uuid;
          lastUuid = entry.uuid;
        }
      }
    }
    return { ops, segment: firstUuid ? { from: firstUuid, to: lastUuid } : null };
  },

  listLocal(limit) {
    const projects = path.join(os.homedir(), '.claude', 'projects');
    const out = [];
    if (!fs.existsSync(projects)) return out;
    for (const slug of fs.readdirSync(projects)) {
      const dir = path.join(projects, slug);
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const p = path.join(dir, entry);
        try {
          out.push({
            scheme: 'claude',
            sessionId: entry.replace(/\.jsonl$/, ''),
            path: p,
            mtime: fs.statSync(p).mtimeMs,
          });
        } catch {
          /* vanished mid-scan */
        }
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return limit ? out.slice(0, limit) : out;
  },
};

// ---------- provider: codex ----------

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** rollout-<ISO-ish timestamp>-<sessionId>.jsonl */
function codexSessionIdFromName(name) {
  const m = /^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/.exec(name);
  return m ? m[1] : null;
}

/** Walk sessions/<YYYY>/<MM>/<DD>/ — a bounded filename scan, never a content scan. */
function codexRolloutFiles() {
  const root = path.join(codexHome(), 'sessions');
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (depth === 3 && e.name.endsWith('.jsonl')) {
        out.push(p);
      }
    }
  };
  walk(root, 0);
  return out;
}

const codexProvider = {
  scheme: 'codex',

  locate(sessionId, root) {
    const v = vendored(root, sessionId);
    if (v) return v;
    for (const p of codexRolloutFiles()) {
      if (codexSessionIdFromName(path.basename(p)) === sessionId) return p;
    }
    return null;
  },

  /**
   * Codex records the diff it ACTUALLY APPLIED, per file, in
   * `patch_apply_end.changes[<abs path>].unified_diff`. So provenance here does
   * not reconstruct intent from edit parameters the way the Claude provider
   * must — it reads the applied patch. Failed applies changed nothing and are
   * skipped; shell/sed edits are simply absent, which is what makes them
   * verify `hybrid`.
   */
  extractFileOps(sessionFile, root, changedFiles = []) {
    const ops = [];
    let firstId;
    let lastId;
    for (const entry of readJsonl(sessionFile)) {
      const payload = entry && entry.payload;
      if (!payload) continue;

      if (entry.type === 'response_item' && typeof payload.id === 'string') {
        if (!firstId) firstId = payload.id;
        lastId = payload.id;
        continue;
      }
      if (payload.type !== 'patch_apply_end' || payload.success !== true) continue;

      const changes = payload.changes || {};
      for (const recorded of Object.keys(changes)) {
        const change = changes[recorded] || {};
        if (typeof change.unified_diff !== 'string') continue;
        const rel = mapToRoot(recorded, root, changedFiles);
        if (rel === null) continue;
        ops.push({
          kind: 'patch',
          tool: 'apply_patch',
          file: rel,
          // Codex stores a bare hunk list; re-header it so `git apply` accepts it.
          patch: `--- a/${rel}\n+++ b/${rel}\n${change.unified_diff.replace(/\n?$/, '\n')}`,
        });
      }
    }
    return { ops, segment: firstId ? { from: firstId, to: lastId } : null };
  },

  listLocal(limit) {
    const out = [];
    for (const p of codexRolloutFiles()) {
      const sessionId = codexSessionIdFromName(path.basename(p));
      if (!sessionId) continue;
      try {
        out.push({ scheme: 'codex', sessionId, path: p, mtime: fs.statSync(p).mtimeMs });
      } catch {
        /* vanished mid-scan */
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return limit ? out.slice(0, limit) : out;
  },
};

/**
 * Which provider wrote a vendored transcript? The spec names vendored files
 * `<sessionId>.jsonl` with no scheme, so recover it from the content: a Codex
 * rollout opens with a `session_meta` line; a Cursor transcript opens with a
 * {role, message} entry carrying no uuid; a Claude entry always has a uuid.
 * Defaults to `claude`, which is also the right answer for pre-v0.12 vendoring.
 */
function sniffScheme(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.slice(0, n).toString('utf8');
    const firstLine = head.split('\n')[0] || '';
    const obj = JSON.parse(firstLine);
    if (obj && obj.type === 'session_meta') return 'codex';
    // Cursor entries are {role, message} with no id of any kind; Claude's
    // always carry a uuid. That absence is the only reliable discriminator.
    if (obj && obj.role && obj.message && !obj.uuid) return 'cursor';
  } catch {
    /* unreadable or torn first line — fall through */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return 'claude';
}

// ---------- provider: cursor ----------

function cursorProjectsDir() {
  return path.join(os.homedir(), '.cursor', 'projects');
}

/**
 * Cursor may serialize a string tool input as a character-indexed object
 * ({"0":"*","1":"*",…}). Reassemble by ascending numeric key; pass real strings
 * through untouched.
 */
function reassembleStringInput(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input).filter((k) => /^\d+$/.test(k));
  if (keys.length === 0) return '';
  return keys.sort((a, b) => Number(a) - Number(b)).map((k) => input[k]).join('');
}

/**
 * Parse an apply-patch ENVELOPE (not a unified diff — no line numbers) into
 * per-file context-matched replacements:
 *
 *   *** Begin Patch
 *   *** Update File: <abs path>
 *   @@
 *    context
 *   -removed
 *   +added
 *   *** End Patch
 *
 * Each hunk becomes { path, oldText, newText }: the removed+context block as it
 * must appear now, and the added+context block to put in its place.
 */
function parseApplyPatchEnvelope(text) {
  const hunks = [];
  let file = null;
  let oldLines = null;
  let newLines = null;
  const flush = () => {
    if (file && oldLines && (oldLines.length || newLines.length)) {
      hunks.push({ path: file, oldText: oldLines.join('\n'), newText: newLines.join('\n') });
    }
    oldLines = null;
    newLines = null;
  };
  for (const raw of String(text).split('\n')) {
    if (raw.startsWith('*** Begin Patch') || raw.startsWith('*** End Patch')) {
      flush();
      continue;
    }
    const m = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(raw);
    if (m) {
      flush();
      file = m[1].trim();
      continue;
    }
    if (raw.startsWith('@@')) {
      flush();
      oldLines = [];
      newLines = [];
      continue;
    }
    if (oldLines === null) continue;
    if (raw.startsWith('-')) oldLines.push(raw.slice(1));
    else if (raw.startsWith('+')) newLines.push(raw.slice(1));
    else {
      // Context line: present on both sides. A leading space is the marker.
      const ctx = raw.startsWith(' ') ? raw.slice(1) : raw;
      oldLines.push(ctx);
      newLines.push(ctx);
    }
  }
  flush();
  return hunks;
}

const cursorProvider = {
  scheme: 'cursor',

  locate(sessionId, root) {
    const v = vendored(root, sessionId);
    if (v) return v;
    const projects = cursorProjectsDir();
    let slugs;
    try {
      slugs = fs.readdirSync(projects);
    } catch {
      return null;
    }
    for (const slug of slugs) {
      const p = path.join(projects, slug, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
    return null;
  },

  /**
   * Cursor entries carry no ids, so segment endpoints are synthesized from the
   * entry index (see docs/spec/session-providers.md). Safe because these
   * transcripts are append-only: an entry's index never changes once written.
   */
  extractFileOps(sessionFile, root, changedFiles = []) {
    const entries = readJsonl(sessionFile);
    const ops = [];
    let firstId;
    let lastId;
    entries.forEach((entry, index) => {
      const content = entry && entry.message && entry.message.content;
      if (!Array.isArray(content)) return;
      let touched = false;
      for (const c of content) {
        if (!c || c.type !== 'tool_use') continue;
        const input = c.input || {};
        const emit = (op) => {
          ops.push(op);
          touched = true;
        };
        if (c.name === 'Write' && input.path) {
          const rel = mapToRoot(input.path, root, changedFiles);
          if (rel === null) continue;
          emit({ kind: 'content', tool: 'Write', file: rel, input: { content: input.contents ?? '' } });
        } else if (c.name === 'StrReplace' && input.path) {
          const rel = mapToRoot(input.path, root, changedFiles);
          if (rel === null) continue;
          emit({
            kind: 'content',
            tool: 'Edit',
            file: rel,
            input: { old_string: input.old_string, new_string: input.new_string },
          });
        } else if (c.name === 'Delete' && input.path) {
          const rel = mapToRoot(input.path, root, changedFiles);
          if (rel === null) continue;
          emit({ kind: 'content', tool: 'Write', file: rel, input: { content: '' } });
        } else if (c.name === 'ApplyPatch') {
          for (const h of parseApplyPatchEnvelope(reassembleStringInput(input))) {
            const rel = mapToRoot(h.path, root, changedFiles);
            if (rel === null) continue;
            emit({
              kind: 'content',
              tool: 'Edit',
              file: rel,
              input: { old_string: h.oldText, new_string: h.newText },
            });
          }
        }
      }
      if (touched) {
        const id = `m${index}`;
        if (!firstId) firstId = id;
        lastId = id;
      }
    });
    return { ops, segment: firstId ? { from: firstId, to: lastId } : null };
  },

  listLocal(limit) {
    const projects = cursorProjectsDir();
    const out = [];
    let slugs;
    try {
      slugs = fs.readdirSync(projects);
    } catch {
      return out;
    }
    for (const slug of slugs) {
      const dir = path.join(projects, slug, 'agent-transcripts');
      let ids;
      try {
        ids = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const sessionId of ids) {
        const p = path.join(dir, sessionId, `${sessionId}.jsonl`);
        try {
          out.push({ scheme: 'cursor', sessionId, path: p, mtime: fs.statSync(p).mtimeMs });
        } catch {
          continue; // no transcript in this directory
        }
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return limit ? out.slice(0, limit) : out;
  },
};

// ---------- registry ----------

const PROVIDERS = { claude: claudeProvider, codex: codexProvider, cursor: cursorProvider };

function providerFor(scheme) {
  return PROVIDERS[scheme] || null;
}

/**
 * Locate a transcript from a ref that may or may not carry a scheme.
 * Returns { scheme, sessionId, path } or null.
 */
function locateSession(ref, root) {
  const parsed = typeof ref === 'string' ? parseSessionRef(ref) : ref;
  if (!parsed) return null;
  const provider = providerFor(parsed.scheme);
  if (!provider) return null;
  const p = provider.locate(parsed.sessionId, root);
  return p ? { scheme: parsed.scheme, sessionId: parsed.sessionId, path: p } : null;
}

/** Every local session across providers, newest first. */
function listLocalSessions(limit) {
  const all = [];
  for (const scheme of SCHEMES) all.push(...PROVIDERS[scheme].listLocal());
  all.sort((a, b) => b.mtime - a.mtime);
  return limit ? all.slice(0, limit) : all;
}

module.exports = {
  SCHEMES,
  sniffScheme,
  parseApplyPatchEnvelope,
  reassembleStringInput,
  parseSessionRef,
  formatSessionRef,
  providerFor,
  locateSession,
  listLocalSessions,
  mapToRoot,
  codexHome,
};
