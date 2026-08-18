/**
 * Sidecar v2 core: append-only thread event logs (docs/spec/sidecar-v2.md).
 * One JSONL file per thread under `.comments/threads/<threadId>.jsonl`.
 * No vscode imports — tests require this module directly from out/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// ---------- types ----------

export interface Baseline {
  kind: 'commit' | 'blob';
  sha: string;
  /** For blob baselines: the HEAD commit at capture time (diff-locality hint). */
  commit?: string;
}

export interface Position {
  line: number;
  char: number;
}

export interface AnchorV2 {
  /** null = legacy/unknown baseline; resolvers fall back to fuzzy matching. */
  baseline: Baseline | null;
  start: Position;
  end: Position;
  /** Verbatim content at [start, end) in the baseline. Last-resort fuzzy key. */
  text: string;
  prefix: string;
  suffix: string;
}

export interface Actor {
  name: string;
  kind: 'human' | 'agent' | 'notary';
  session?: string;
}

export type ResolveReason = 'fixed' | 'stale' | 'wontfix' | 'obsolete' | 'unknown';
export type ReanchorMethod = 'manual' | 'delta' | 'diff' | 'fuzzy';
export type Severity = 'normal' | 'blocking';

export interface ThreadEvent {
  id: string;
  type: string;
  seq: number;
  ts: string;
  actor: Actor;
  /** Per-type payload fields (spec "Event types"). Unknown fields are preserved. */
  [key: string]: unknown;
}

export interface ThreadComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  edited: boolean;
  deleted: boolean;
  /** Claude Code session that produced this comment (from actor.session). */
  session?: string;
}

export interface Suggestion {
  id: string;
  patch: string;
  baseline: Baseline | null;
  author: string;
  createdAt: string;
  status: 'open' | 'accepted' | 'rejected';
}

export interface Claim {
  actor: Actor;
  ts: string;
  ttlSeconds: number;
}

export interface ThreadState {
  id: string;
  file: string;
  status: 'open' | 'resolved';
  severity: Severity;
  anchor: AnchorV2;
  comments: ThreadComment[];
  suggestions: Suggestion[];
  /** Latest un-released claim; expiry is the caller's concern (see liveClaim). */
  claim?: Claim;
  resolveReason?: ResolveReason;
  resolveSha?: string;
  /** Method of the latest persisted re-anchor, if any (fuzzy must be badged). */
  reanchorMethod?: ReanchorMethod;
  createdAt: string;
  events: ThreadEvent[];
}

/** The advisory lease that is currently live, if any (spec: claims are leases with TTL). */
export function liveClaim(state: ThreadState, now: Date = new Date()): Claim | undefined {
  const c = state.claim;
  if (!c) return undefined;
  return now.getTime() < Date.parse(c.ts) + c.ttlSeconds * 1000 ? c : undefined;
}

export const THREADS_SUBDIR = path.join('.comments', 'threads');
export const GITATTRIBUTES_LINE = '.comments/threads/*.jsonl merge=union';

export function newThreadId(): string {
  return `th_${randomUUID()}`;
}

// ---------- parse / fold ----------

/** Parse a JSONL log. Torn or unparseable lines are skipped; duplicates (by id) removed. */
export function parseLog(text: string): ThreadEvent[] {
  const seen = new Set<string>();
  const events: ThreadEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: ThreadEvent;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // torn tail line from a crashed writer
    }
    if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || typeof ev.type !== 'string') continue;
    if (seen.has(ev.id)) continue; // union-merge duplicate
    seen.add(ev.id);
    events.push(ev);
  }
  return sortEvents(events);
}

/** Fold order: (seq, ts, id) ascending — deterministic on every machine. */
export function sortEvents(events: ThreadEvent[]): ThreadEvent[] {
  return [...events].sort((a, b) => {
    const seqA = typeof a.seq === 'number' ? a.seq : 0;
    const seqB = typeof b.seq === 'number' ? b.seq : 0;
    if (seqA !== seqB) return seqA - seqB;
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Derive thread state from its event log. Returns null without a valid `created` event. */
export function foldThread(threadId: string, events: ThreadEvent[]): ThreadState | null {
  const sorted = sortEvents(events);
  const created = sorted.find((e) => e.type === 'created');
  if (!created || typeof created.file !== 'string' || !created.anchor) return null;

  const state: ThreadState = {
    id: threadId,
    file: created.file,
    status: 'open',
    severity: (created.severity as Severity) === 'blocking' ? 'blocking' : 'normal',
    anchor: created.anchor as AnchorV2,
    comments: [],
    suggestions: [],
    createdAt: created.ts,
    events: sorted,
  };

  const byCommentId = new Map<string, ThreadComment>();
  for (const ev of sorted) {
    switch (ev.type) {
      case 'created':
      case 'replied': {
        const comment: ThreadComment = {
          id: (ev.commentId as string) ?? ev.id,
          author: ev.actor?.name ?? 'unknown',
          body: (ev.body as string) ?? '',
          createdAt: ev.ts,
          edited: false,
          deleted: false,
          session: ev.actor?.session,
        };
        byCommentId.set(comment.id, comment);
        state.comments.push(comment);
        break;
      }
      case 'edited': {
        const target = byCommentId.get(ev.commentId as string);
        if (target) {
          target.body = (ev.body as string) ?? target.body;
          target.edited = true;
        }
        break;
      }
      case 'comment_deleted': {
        const target = byCommentId.get(ev.commentId as string);
        if (target) target.deleted = true;
        break;
      }
      case 'resolved':
        state.status = 'resolved';
        state.resolveReason = (ev.reason as ResolveReason) ?? 'unknown';
        state.resolveSha = ev.sha as string | undefined;
        break;
      case 'reopened':
        state.status = 'open';
        state.resolveReason = undefined;
        state.resolveSha = undefined;
        break;
      case 'severity_changed':
        state.severity = (ev.severity as Severity) === 'blocking' ? 'blocking' : 'normal';
        break;
      case 'reanchored':
        if (ev.anchor) {
          state.anchor = ev.anchor as AnchorV2;
          state.reanchorMethod = ev.method as ReanchorMethod;
        }
        break;
      case 'renamed':
        if (typeof ev.file === 'string') state.file = ev.file;
        break;
      case 'claimed':
        state.claim = {
          actor: ev.actor,
          ts: ev.ts,
          ttlSeconds: typeof ev.ttlSeconds === 'number' ? ev.ttlSeconds : 3600,
        };
        break;
      case 'released':
        if (state.claim && state.claim.actor.name === ev.actor?.name) state.claim = undefined;
        break;
      case 'suggested':
        if (typeof ev.patch === 'string') {
          state.suggestions.push({
            id: (ev.suggestionId as string) ?? ev.id,
            patch: ev.patch,
            baseline: (ev.baseline as Baseline) ?? null,
            author: ev.actor?.name ?? 'unknown',
            createdAt: ev.ts,
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
      default:
        break; // unknown types: preserved in state.events, ignored by the fold
    }
  }
  return state;
}

// ---------- locked appends (spec "Store model") ----------

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath: string): number {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch {
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between attempts
      }
      if (Date.now() > deadline) throw new Error(`timed out acquiring ${lockPath}`);
      sleepSync(15);
    }
  }
}

export function readLog(filePath: string): ThreadEvent[] {
  try {
    return parseLog(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Serialized append: lock → read tail for seq → append one complete line → unlock.
 * `build` receives the next seq and returns the event's type-specific fields.
 */
export function appendEvent(
  filePath: string,
  actor: Actor,
  type: string,
  fields: Record<string, unknown>,
  now: () => Date = () => new Date(),
): ThreadEvent {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockFd = acquireLock(filePath + '.lock');
  try {
    const seq = readLog(filePath).reduce((max, e) => Math.max(max, e.seq || 0), 0) + 1;
    const event: ThreadEvent = {
      id: `ev_${randomUUID()}`,
      type,
      seq,
      ts: now().toISOString(),
      actor,
      ...fields,
    };
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
    return event;
  } finally {
    fs.closeSync(lockFd);
    fs.rmSync(filePath + '.lock', { force: true });
  }
}
