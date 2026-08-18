import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  Actor,
  AnchorV2,
  GITATTRIBUTES_LINE,
  Severity,
  ThreadEvent,
  ThreadState,
  appendEvent,
  foldThread,
  newThreadId,
  readLog,
} from './threadLog';
import { captureBaseline, primaryWorktreeRoot } from './baseline';
import { SidecarFile } from './model';

/**
 * Sidecar v2 store (docs/spec/sidecar-v2.md). One live store per repository:
 * `.comments/threads/<threadId>.jsonl` in the PRIMARY working tree, shared by
 * every actor on the machine (extension, MCP processes, worktree agents).
 * Vendored Claude sessions live under `.comments/sessions/`.
 */
export class Store {
  private cachedLiveRoot: string | undefined;

  /** Root of the live store: the repo's primary working tree (worktree-safe). */
  liveRoot(): string | undefined {
    if (this.cachedLiveRoot) return this.cachedLiveRoot;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return undefined;
    this.cachedLiveRoot = primaryWorktreeRoot(folder);
    return this.cachedLiveRoot;
  }

  threadsDir(): string | undefined {
    const root = this.liveRoot();
    return root ? path.join(root, '.comments', 'threads') : undefined;
  }

  sessionsDir(): string | undefined {
    const root = this.liveRoot();
    return root ? path.join(root, '.comments', 'sessions') : undefined;
  }

  /** Kept for callers that had per-uri context; the store is repo-global now. */
  defaultSessionsDir(): string | undefined {
    return this.sessionsDir();
  }

  /** Live-root-relative posix path, or undefined when outside the repository. */
  relPath(uri: vscode.Uri): string | undefined {
    // Files may live in a linked worktree; their checkout-relative path equals
    // their repo-relative path, so resolve against the containing folder.
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const root = folder ? primaryWorktreeRoot(folder) : this.liveRoot();
    const base = folder ?? root;
    if (!base) return undefined;
    const rel = path.relative(base, uri.fsPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join('/');
  }

  docUri(relFile: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return undefined;
    return vscode.Uri.file(path.join(folder, ...relFile.split('/')));
  }

  threadFilePath(threadId: string): string | undefined {
    const dir = this.threadsDir();
    if (!dir || !/^th_[A-Za-z0-9-]+$/.test(threadId)) return undefined;
    return path.join(dir, `${threadId}.jsonl`);
  }

  // ---------- reads ----------

  getThread(threadId: string): ThreadState | undefined {
    const p = this.threadFilePath(threadId);
    if (!p || !fs.existsSync(p)) return undefined;
    return foldThread(threadId, readLog(p)) ?? undefined;
  }

  listThreads(): ThreadState[] {
    const dir = this.threadsDir();
    if (!dir || !fs.existsSync(dir)) return [];
    const out: ThreadState[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const state = foldThread(name.slice(0, -'.jsonl'.length), readLog(path.join(dir, name)));
      if (state && state.comments.some((c) => !c.deleted)) out.push(state);
    }
    return out;
  }

  threadsForFile(relFile: string): ThreadState[] {
    return this.listThreads().filter((t) => t.file === relFile);
  }

  /** Threads grouped by target file — powers the tree view and badges. */
  listByFile(): Array<{ docUri: vscode.Uri; file: string; threads: ThreadState[] }> {
    const byFile = new Map<string, ThreadState[]>();
    for (const t of this.listThreads()) {
      const list = byFile.get(t.file) ?? [];
      list.push(t);
      byFile.set(t.file, list);
    }
    const out: Array<{ docUri: vscode.Uri; file: string; threads: ThreadState[] }> = [];
    for (const [file, threads] of byFile) {
      const docUri = this.docUri(file);
      if (docUri) out.push({ docUri, file, threads });
    }
    return out;
  }

  // ---------- writes (locked appends; see threadLog.appendEvent) ----------

  /** Last content we wrote per thread file — lets the watcher ignore our own writes. */
  private readonly lastWritten = new Map<string, string>();

  wasSelfWrite(fsPath: string): boolean {
    if (!fs.existsSync(fsPath)) return this.lastWritten.get(fsPath) === '<deleted>';
    try {
      return this.lastWritten.get(fsPath) === fs.readFileSync(fsPath, 'utf8');
    } catch {
      return false;
    }
  }

  append(threadId: string, actor: Actor, type: string, fields: Record<string, unknown>): ThreadEvent | undefined {
    const p = this.threadFilePath(threadId);
    if (!p) return undefined;
    const event = appendEvent(p, actor, type, fields);
    try {
      this.lastWritten.set(p, fs.readFileSync(p, 'utf8'));
    } catch {
      /* watcher will reload; harmless */
    }
    return event;
  }

  createThread(
    relFile: string,
    anchor: AnchorV2,
    body: string,
    actor: Actor,
    severity: Severity = 'normal',
  ): string | undefined {
    if (!this.threadsDir()) return undefined;
    this.ensureGitattributes();
    const id = newThreadId();
    this.append(id, actor, 'created', {
      version: 2,
      file: relFile,
      anchor,
      body,
      commentId: `c_${randomUUID()}`,
      severity,
    });
    return id;
  }

  /** Explicit user delete (destructive, confirmed in UI) — removes the log file. */
  deleteThreadFile(threadId: string): void {
    const p = this.threadFilePath(threadId);
    if (p && fs.existsSync(p)) {
      fs.rmSync(p);
      this.lastWritten.set(p, '<deleted>');
    }
  }

  /** Source file renamed: record on every thread targeting it. */
  renameFile(oldRel: string, newRel: string, actor: Actor): void {
    for (const t of this.threadsForFile(oldRel)) {
      this.append(t.id, actor, 'renamed', { file: newRel });
    }
  }

  /** Source file deleted: open threads become resolved(obsolete), never erased. */
  markFileDeleted(relFile: string, actor: Actor): void {
    for (const t of this.threadsForFile(relFile)) {
      if (t.status === 'open') {
        this.append(t.id, actor, 'resolved', { reason: 'obsolete', note: `${relFile} was deleted` });
      }
    }
  }

  ensureGitattributes(): void {
    const root = this.liveRoot();
    if (!root) return;
    const p = path.join(root, '.gitattributes');
    try {
      const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
      if (current.includes(GITATTRIBUTES_LINE)) return;
      fs.writeFileSync(p, current + (current && !current.endsWith('\n') ? '\n' : '') + GITATTRIBUTES_LINE + '\n');
    } catch {
      /* non-fatal */
    }
  }

  // ---------- v1 migration ----------

  /** Any v1 mirrored-tree sidecars left under .comments/? */
  hasV1Sidecars(): boolean {
    return this.v1SidecarPaths().length > 0;
  }

  private v1SidecarPaths(): string[] {
    const root = this.liveRoot();
    if (!root) return [];
    const base = path.join(root, '.comments');
    if (!fs.existsSync(base)) return [];
    const out: string[] = [];
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (dir === base && (e.name === 'sessions' || e.name === 'threads')) continue;
          stack.push(p);
        } else if (e.name.endsWith('.json')) {
          out.push(p);
        }
      }
    }
    return out;
  }

  /**
   * One-shot v1 → v2 migration (spec "Migration from v1"): each v1 thread
   * becomes an event log; anchors are re-resolved against the current file and
   * re-baselined (or kept with baseline:null when orphaned); v1 files are
   * deleted. Returns the number of migrated threads.
   */
  migrateV1(): number {
    const root = this.liveRoot();
    if (!root) return 0;
    let migrated = 0;
    for (const sidecarPath of this.v1SidecarPaths()) {
      let data: SidecarFile;
      try {
        data = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      } catch {
        continue;
      }
      if (!Array.isArray(data.threads)) continue;
      for (const thread of data.threads) {
        const first = thread.comments[0];
        if (!first) continue;
        const anchor = this.migrateAnchor(root, data.file, thread.anchor);
        const id = thread.id.startsWith('th_') ? thread.id : `th_${thread.id}`;
        const actorOf = (author: string): Actor => ({ name: author, kind: 'human' });
        const at = (iso: string) => () => new Date(iso);
        const p = this.threadFilePath(id);
        if (!p || fs.existsSync(p)) continue;
        appendEvent(p, actorOf(first.author), 'created', {
          version: 2,
          file: data.file,
          anchor,
          body: first.body,
          commentId: first.id,
        }, at(first.createdAt));
        for (const c of thread.comments.slice(1)) {
          appendEvent(p, actorOf(c.author), 'replied', { commentId: c.id, body: c.body }, at(c.createdAt));
        }
        if (thread.status === 'resolved') {
          const lastTs = thread.comments[thread.comments.length - 1].createdAt;
          appendEvent(p, { name: 'migration', kind: 'notary' }, 'resolved', { reason: 'unknown' }, at(lastTs));
        }
        migrated++;
      }
      fs.rmSync(sidecarPath);
      // remove now-empty mirrored directories
      let dir = path.dirname(sidecarPath);
      const base = path.join(root, '.comments');
      while (dir !== base && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      }
    }
    if (migrated > 0) this.ensureGitattributes();
    return migrated;
  }

  /** Re-resolve a v1 anchor against the current file and give it a baseline. */
  private migrateAnchor(root: string, relFile: string, v1: SidecarFile['threads'][0]['anchor']): AnchorV2 {
    const legacy: AnchorV2 = {
      baseline: null,
      start: { line: v1.startLine, char: v1.startChar },
      end: { line: v1.endLine, char: v1.endChar },
      text: v1.text,
      prefix: v1.prefix,
      suffix: v1.suffix,
    };
    const abs = path.join(root, ...relFile.split('/'));
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      return legacy;
    }
    const offset = exactOffset(content, v1);
    if (offset === null) return legacy;
    const start = positionAt(content, offset);
    const end = positionAt(content, offset + v1.text.length);
    return {
      baseline: captureBaseline(root, relFile, content),
      start,
      end,
      text: v1.text,
      prefix: content.slice(Math.max(0, offset - 120), offset),
      suffix: content.slice(offset + v1.text.length, offset + v1.text.length + 120),
    };
  }
}

// ---------- small pure helpers ----------

function positionAt(content: string, offset: number): { line: number; char: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, char: offset - lineStart };
}

/** v1 anchor → offset in current content: exact position, else context-scored search. */
function exactOffset(content: string, v1: { startLine: number; startChar: number; text: string; prefix: string; suffix: string }): number | null {
  if (!v1.text) return null;
  const lines = content.split('\n');
  if (v1.startLine < lines.length) {
    let off = 0;
    for (let i = 0; i < v1.startLine; i++) off += lines[i].length + 1;
    off += v1.startChar;
    if (content.startsWith(v1.text, off)) return off;
  }
  let best: number | null = null;
  let bestScore = -Infinity;
  for (let i = content.indexOf(v1.text); i !== -1; i = content.indexOf(v1.text, i + 1)) {
    const prefix = content.slice(Math.max(0, i - v1.prefix.length), i);
    const suffix = content.slice(i + v1.text.length, i + v1.text.length + v1.suffix.length);
    let score = 0;
    for (let j = 0; j < Math.min(prefix.length, v1.prefix.length); j++) {
      if (prefix[prefix.length - 1 - j] === v1.prefix[v1.prefix.length - 1 - j]) score++;
      else break;
    }
    for (let j = 0; j < Math.min(suffix.length, v1.suffix.length); j++) {
      if (suffix[j] === v1.suffix[j]) score++;
      else break;
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
