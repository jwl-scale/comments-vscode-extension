/**
 * Agent-session providers, extension side (docs/spec/session-providers.md).
 *
 * Deliberately mirrors bin/lib/session-providers.js rather than importing it:
 * that module is plain JS required by `node` processes outside the extension
 * host, this one returns the editor's SessionGraph shape and is compiled to
 * out/ for tests. The shared surface is small (locate + list); the graph
 * building below has no counterpart on the bin side at all.
 *
 * No vscode imports — tested directly from out/, like refs.ts and sessions.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentScheme } from './refs';
import { Fork, GraphMessage, GraphToolUse, SessionGraph } from './model';

export interface DiscoveredSession {
  scheme: AgentScheme;
  sessionId: string;
  jsonlPath: string;
  mtime: number;
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** rollout-<timestamp>-<sessionId>.jsonl */
export function codexSessionIdFromName(name: string): string | null {
  const m = /^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/.exec(name);
  return m ? m[1] : null;
}

/** Walk sessions/<YYYY>/<MM>/<DD>/ — a bounded filename scan, never a content scan. */
export function codexRolloutFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
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
  walk(path.join(codexHome(), 'sessions'), 0);
  return out;
}

export function findLocalCodexSessions(): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  for (const p of codexRolloutFiles()) {
    const sessionId = codexSessionIdFromName(path.basename(p));
    if (!sessionId) continue;
    try {
      out.push({ scheme: 'codex', sessionId, jsonlPath: p, mtime: fs.statSync(p).mtimeMs });
    } catch {
      /* vanished mid-scan */
    }
  }
  return out;
}

export function locateCodexSession(sessionId: string): string | null {
  for (const p of codexRolloutFiles()) {
    if (codexSessionIdFromName(path.basename(p)) === sessionId) return p;
  }
  return null;
}

// ---------- cursor ----------

export function cursorProjectsDir(): string {
  return path.join(os.homedir(), '.cursor', 'projects');
}

/** `~/.cursor/projects/<slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl` */
export function findLocalCursorSessions(): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  let slugs: string[];
  try {
    slugs = fs.readdirSync(cursorProjectsDir());
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const dir = path.join(cursorProjectsDir(), slug, 'agent-transcripts');
    let ids: string[];
    try {
      ids = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const sessionId of ids) {
      const jsonlPath = path.join(dir, sessionId, `${sessionId}.jsonl`);
      try {
        out.push({ scheme: 'cursor', sessionId, jsonlPath, mtime: fs.statSync(jsonlPath).mtimeMs });
      } catch {
        continue; // directory without a transcript
      }
    }
  }
  return out;
}

export function locateCursorSession(sessionId: string): string | null {
  let slugs: string[];
  try {
    slugs = fs.readdirSync(cursorProjectsDir());
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const p = path.join(cursorProjectsDir(), slug, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Cursor transcripts are a flat {role, message} sequence with NO ids, so
 * message ids are synthesized from the entry index (`m<index>`) — stable only
 * because these files are append-only. See docs/spec/session-providers.md.
 *
 * Like Codex, there is no reply tree, so the graph is a linear spine.
 */
export function loadCursorGraph(jsonlPath: string, sessionId: string): SessionGraph | undefined {
  if (!fs.existsSync(jsonlPath)) return undefined;
  const entries = readJsonl(jsonlPath);

  const messages: GraphMessage[] = [];
  let prevUuid: string | null = null;
  let title = '';

  entries.forEach((entry, index) => {
    if (!entry || !entry.role || !entry.message) return;
    const content = entry.message.content;
    const toolUses: GraphToolUse[] = [];
    let text = '';
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text') text += (text ? '\n' : '') + (block.text ?? '');
        else if (block?.type === 'tool_use') {
          toolUses.push({
            id: String(block.id ?? `${index}-${toolUses.length}`),
            name: String(block.name ?? 'tool'),
            summary: summarizeCursorTool(block.input),
          });
        }
      }
    } else if (typeof content === 'string') {
      text = content;
    }
    if (!text.trim() && toolUses.length === 0) return;

    // Cursor wraps the real prompt in <user_query> tags alongside a timestamp;
    // show the query itself rather than the scaffolding.
    const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
    if (query) text = query[1];
    if (!title && entry.role === 'user') title = text.replace(/\s+/g, ' ').slice(0, 80);

    const uuid = `m${index}`;
    messages.push({
      uuid,
      parentUuid: prevUuid,
      role: entry.role === 'user' ? 'user' : 'assistant',
      timestamp: String(entry.timestamp ?? ''),
      text,
      toolUses,
      spawns: [],
    });
    prevUuid = uuid;
  });

  return {
    sessionId,
    title: title || `cursor session ${sessionId.slice(0, 8)}`,
    messages,
    mainPath: messages.map((m) => m.uuid),
    forks: [],
    subagents: [],
  };
}

function summarizeCursorTool(input: unknown): string {
  if (!input) return '';
  const i = input as Record<string, unknown>;
  const value = i.description ?? i.command ?? i.pattern ?? i.path ?? i.query ?? '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text).replace(/\s+/g, ' ').slice(0, 100);
}

/**
 * Which provider wrote a transcript? Vendored files are named `<sessionId>.jsonl`
 * with no scheme (sidecar spec), so recover it from content: a Codex rollout
 * opens with a `session_meta` line, a Cursor transcript with an id-less
 * {role, message} entry. Defaults to `claude`, which is also correct for
 * everything vendored before v0.12.
 */
export function sniffScheme(file: string): AgentScheme {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, n).toString('utf8').split('\n')[0] || '';
    const first = JSON.parse(firstLine);
    if (first?.type === 'session_meta') return 'codex';
    // Cursor entries carry no id; Claude's always have a uuid.
    if (first?.role && first?.message && !first?.uuid) return 'cursor';
  } catch {
    /* unreadable or torn first line */
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

// ---------- codex transcript → SessionGraph ----------

function readJsonl(p: string): any[] {
  const out: any[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* tolerate torn lines */
    }
  }
  return out;
}

function codexText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : (b?.text ?? '')))
    .filter(Boolean)
    .join('\n');
}

function summarizeCodexTool(name: string, input: unknown): string {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  return text.replace(/\s+/g, ' ').slice(0, 100);
}

/**
 * Codex rollouts are a linear sequence: there is no parentUuid, so there are no
 * forks to recover. `compacted` entries start a new spine segment — the same
 * multi-root shape Claude sessions take after a continuation, which the webview
 * already renders.
 *
 * `developer` messages (the injected permissions/instructions preamble) are
 * dropped: they are harness scaffolding, not conversation, and showing them
 * buries the actual first user turn.
 */
export function loadCodexGraph(jsonlPath: string, sessionId: string): SessionGraph | undefined {
  if (!fs.existsSync(jsonlPath)) return undefined;
  const entries = readJsonl(jsonlPath);

  const messages: GraphMessage[] = [];
  let prevUuid: string | null = null;
  let breakSpine = false;
  let title = '';

  const push = (uuid: string, role: GraphMessage['role'], timestamp: string, text: string): GraphMessage => {
    const msg: GraphMessage = {
      uuid,
      parentUuid: breakSpine ? null : prevUuid,
      role,
      timestamp,
      text,
      toolUses: [],
      spawns: [],
    };
    breakSpine = false;
    prevUuid = uuid;
    messages.push(msg);
    return msg;
  };

  let synthetic = 0;
  for (const entry of entries) {
    const payload = entry?.payload;
    const ts = String(entry?.timestamp ?? '');

    if (entry?.type === 'compacted') {
      breakSpine = true;
      continue;
    }
    if (!payload) continue;

    if (entry.type === 'response_item' && payload.type === 'message') {
      if (payload.role === 'developer' || payload.role === 'system') continue;
      const text = codexText(payload.content);
      if (!text.trim()) continue;
      const role: GraphMessage['role'] = payload.role === 'user' ? 'user' : 'assistant';
      if (!title && role === 'user') title = text.replace(/\s+/g, ' ').slice(0, 80);
      push(String(payload.id ?? `msg_${synthetic++}`), role, ts, text);
      continue;
    }

    if (
      entry.type === 'response_item' &&
      (payload.type === 'custom_tool_call' || payload.type === 'function_call')
    ) {
      const tool: GraphToolUse = {
        id: String(payload.call_id ?? payload.id ?? ''),
        name: String(payload.name ?? 'tool'),
        summary: summarizeCodexTool(payload.name, payload.input ?? payload.arguments),
      };
      // Attach to the current assistant turn; start one if the tool call is the
      // first thing in a segment (common right after a compaction).
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') last.toolUses.push(tool);
      else push(String(payload.id ?? `tool_${synthetic++}`), 'assistant', ts, '').toolUses.push(tool);
    }
  }

  // Linear spine: every message, in order. No forks are recoverable.
  const mainPath = messages.map((m) => m.uuid);
  const forks: Fork[] = [];

  return {
    sessionId,
    title: title || `codex session ${sessionId.slice(0, 8)}`,
    messages,
    mainPath,
    forks,
    subagents: [],
  };
}
