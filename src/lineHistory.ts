/**
 * Phase 4: line-level history — join code ancestry (git log -L / blame)
 * against the conversation layer (trailers, briefs, thread logs at each
 * ancestry commit). No vscode imports — tested directly from out/.
 */

import { spawnSync } from 'child_process';
import { foldThread, parseLog, ThreadState } from './threadLog';

function git(cwd: string, args: string[]): string | null {
  try {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    return res.status === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

export interface CommitTrailers {
  threads: string[];
  resolves: string[];
  session: string | null;
  provenance: string | null;
  metaFor: string | null;
}

/** Parse the Comments/Claude-Session/Provenance trailers out of a commit message. */
export function parseTrailers(message: string): CommitTrailers {
  const out: CommitTrailers = { threads: [], resolves: [], session: null, provenance: null, metaFor: null };
  for (const line of message.split('\n')) {
    let m;
    if ((m = line.match(/^Comments-Thread:\s*(\S+)/))) out.threads.push(m[1]);
    else if ((m = line.match(/^Comments-Resolves:\s*(\S+)/))) out.resolves.push(m[1]);
    else if ((m = line.match(/^Claude-Session:\s*(\S+)/))) out.session = m[1];
    else if ((m = line.match(/^Provenance:\s*(\S+)/))) out.provenance = m[1];
    else if ((m = line.match(/^Comments-Meta-For:\s*(\S+)/))) out.metaFor = m[1];
  }
  return out;
}

export interface HistoryEntry {
  sha: string;
  subject: string;
  date: string;
  author: string;
  trailers: CommitTrailers;
  /** Threads anchored to this file at this commit (positions exact at that sha). */
  threadsAtCommit: Array<{ threadId: string; status: string; startLine: number; firstComment: string }>;
  /** Landing brief, when this commit has one recorded. */
  briefPath?: string;
}

/**
 * Walk a line range's ancestry with `git log -L` and join each commit against
 * the conversation layer as it existed AT that commit.
 */
export function lineHistory(root: string, relFile: string, startLine1: number, endLine1: number): HistoryEntry[] {
  const log = git(root, [
    'log',
    `-L${startLine1},${endLine1}:${relFile}`,
    '--no-patch',
    '--format=%x1e%H%x1f%s%x1f%cI%x1f%an%x1f%B',
  ]);
  if (!log) return [];
  const entries: HistoryEntry[] = [];
  for (const chunk of log.split('\x1e')) {
    if (!chunk.trim()) continue;
    const [sha, subject, date, author, body] = chunk.split('\x1f');
    if (!sha?.trim()) continue;
    const trailers = parseTrailers(body ?? '');
    entries.push({
      sha: sha.trim(),
      subject: subject ?? '',
      date: date ?? '',
      author: author ?? '',
      trailers,
      threadsAtCommit: threadsOnFileAt(root, sha.trim(), relFile),
      briefPath: briefFor(root, sha.trim()),
    });
  }
  return entries;
}

/** Trailers for the commit that last touched one line (blame → reasoning). */
export function blameLine(root: string, relFile: string, line1: number): { sha: string; subject: string; trailers: CommitTrailers } | null {
  const out = git(root, ['blame', '-l', '-L', `${line1},${line1}`, 'HEAD', '--', relFile]);
  if (!out) return null;
  const sha = out.split(/\s/)[0]?.replace(/^\^/, '');
  if (!sha || /^0+$/.test(sha)) return null;
  const message = git(root, ['show', '-s', '--format=%B', sha]);
  if (message === null) return null;
  return { sha, subject: message.split('\n')[0], trailers: parseTrailers(message) };
}

/** Threads anchored to relFile in the sidecar tree as committed at sha. */
export function threadsOnFileAt(
  root: string,
  sha: string,
  relFile: string,
): Array<{ threadId: string; status: string; startLine: number; firstComment: string }> {
  const listing = git(root, ['ls-tree', '--name-only', sha, '.comments/threads/']);
  if (!listing) return [];
  const out = [];
  for (const p of listing.split('\n')) {
    if (!p.endsWith('.jsonl')) continue;
    const content = git(root, ['show', `${sha}:${p}`]);
    if (!content) continue;
    const threadId = p.split('/').pop()!.replace(/\.jsonl$/, '');
    const state: ThreadState | null = foldThread(threadId, parseLog(content));
    if (!state || state.file !== relFile) continue;
    out.push({
      threadId,
      status: state.status,
      startLine: state.anchor.start.line + 1,
      firstComment: state.comments.find((c) => !c.deleted)?.body ?? '',
    });
  }
  return out;
}

function briefFor(root: string, sha: string): string | undefined {
  const rev = (git(root, ['rev-list', '--all', '-1', '--', `.comments/briefs/${sha}.md`]) ?? '').trim();
  return rev ? `${rev}:.comments/briefs/${sha}.md` : undefined;
}

/** Read a brief by its `<rev>:<path>` locator (from HistoryEntry.briefPath). */
export function readBrief(root: string, locator: string): string | null {
  return git(root, ['show', locator]);
}
