/**
 * Anchor baselines (docs/spec/sidecar-v2.md "Anchors"): capture against a git
 * commit or blob, recover baseline content, and translate positions from
 * baseline to current content via a line diff. No vscode imports — the diff
 * translation is pure and tested directly from out/.
 */

import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { AnchorV2, Baseline, Position } from './threadLog';

// ---------- git plumbing ----------

function git(cwd: string, args: string[], input?: string): string | null {
  try {
    const res = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) return null;
    return res.stdout;
  } catch {
    return null;
  }
}

/**
 * The live comment store lives in the repository's PRIMARY working tree
 * (spec "Store model") — resolve it from any checkout, including linked
 * worktrees, via the git common dir. Falls back to `dir` outside git.
 */
export function primaryWorktreeRoot(dir: string): string {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return dir;
  const commonDir = common.trim();
  if (path.basename(commonDir) === '.git') return path.dirname(commonDir);
  return dir; // bare or unusual layout: stay where we are
}

/** Absolute git common dir (shared across worktrees), or null outside git. */
export function gitCommonDir(dir: string): string | null {
  const out = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return out ? out.trim() : null;
}

export function headSha(root: string): string | null {
  const out = git(root, ['rev-parse', 'HEAD']);
  return out ? out.trim() : null;
}

/** Tracked and unmodified (index and worktree) at HEAD. */
export function isCleanAtHead(root: string, relFile: string): boolean {
  const tracked = git(root, ['ls-files', '--error-unmatch', '--', relFile]);
  if (tracked === null) return false;
  const status = git(root, ['status', '--porcelain', '--', relFile]);
  return status !== null && status.trim() === '';
}

/** git blob hash of content, computed without invoking git. */
export function gitBlobSha(content: string | Buffer): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

/** Persist content into the object store so blob baselines stay recoverable. */
export function writeBlob(root: string, content: string): string | null {
  const out = git(root, ['hash-object', '-w', '--stdin'], content);
  return out ? out.trim() : null;
}

/**
 * Capture a baseline for `relFile` whose current buffer content is `content`:
 * clean at HEAD → commit baseline; dirty → blob baseline (persisted to the
 * odb); no git → null (anchor degrades to fuzzy-only, per spec).
 */
export function captureBaseline(root: string, relFile: string, content: string): Baseline | null {
  const head = headSha(root);
  if (!head) return null;
  if (isCleanAtHead(root, relFile)) {
    const committed = git(root, ['show', `HEAD:${relFile}`]);
    if (committed === content) return { kind: 'commit', sha: head };
  }
  const blob = writeBlob(root, content) ?? gitBlobSha(content);
  return { kind: 'blob', sha: blob, commit: head };
}

/** Recover the file content a baseline refers to. */
export function baselineContent(root: string, relFile: string, baseline: Baseline | null): string | null {
  if (!baseline) return null;
  if (baseline.kind === 'commit') return git(root, ['show', `${baseline.sha}:${relFile}`]);
  return git(root, ['cat-file', 'blob', baseline.sha]);
}

/** Apply a unified diff to the working tree (suggestion accept). 3-way fallback
 *  tolerates drift since the suggestion's baseline. */
export function applyPatch(root: string, patch: string): { ok: boolean; error?: string } {
  const normalized = patch.endsWith('\n') ? patch : patch + '\n';
  for (const extra of [[], ['--3way']]) {
    try {
      const res = spawnSync('git', ['apply', '--whitespace=nowarn', ...extra, '-'], {
        cwd: root,
        input: normalized,
        encoding: 'utf8',
      });
      if (res.status === 0) return { ok: true };
      if (extra.length > 0) return { ok: false, error: res.stderr.trim().slice(0, 400) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  return { ok: false, error: 'git apply failed' };
}

// ---------- line diff (Myers O(ND)) + position translation ----------

type LineMap = Int32Array; // baseline line -> current line, or -1 if the line was changed/deleted

/** Map each baseline line to its current line via an LCS of the two texts. */
export function lineMap(baseText: string, curText: string): LineMap {
  const a = baseText.split('\n');
  const b = curText.split('\n');
  const map = new Int32Array(a.length).fill(-1);
  if (baseText === curText) {
    for (let i = 0; i < a.length; i++) map[i] = i;
    return map;
  }

  // Myers diff over line hashes; record matched (keep) pairs.
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found === -1) return map; // pathological; treat everything as changed

  // Backtrack, marking diagonal (unchanged) lines.
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      map[x] = y;
    }
    if (prevK === k + 1) y = prevY; // insertion in b
    else x = prevX; // deletion from a
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    map[x] = y;
  }
  return map;
}

export interface Translated {
  start: Position;
  end: Position;
  /** True when every anchored line survived unchanged — positions are exact. */
  exact: boolean;
}

/**
 * Translate an anchor's positions from baseline content to current content.
 * Returns null when the anchored lines themselves were modified — the honest
 * ambiguous case; callers fall back to fuzzy matching or orphan the thread.
 */
export function translateAnchor(baseText: string, curText: string, anchor: AnchorV2): Translated | null {
  const map = lineMap(baseText, curText);
  const startLine = anchor.start.line;
  const endLine = anchor.end.line;
  if (startLine >= map.length || endLine >= map.length) return null;
  const newStart = map[startLine];
  const newEnd = map[endLine];
  if (newStart === -1 || newEnd === -1) return null;
  // Interior lines of a multi-line anchor must survive too, contiguously.
  if (newEnd - newStart !== endLine - startLine) return null;
  for (let l = startLine + 1; l < endLine; l++) {
    if (map[l] !== newStart + (l - startLine)) return null;
  }
  return {
    start: { line: newStart, char: anchor.start.char },
    end: { line: newEnd, char: anchor.end.char },
    exact: true,
  };
}
