import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Fork, GraphMessage, GraphToolUse, SessionGraph, SubagentInfo } from './model';
import { AgentScheme } from './refs';
import {
  cursorChatNames,
  findLocalCodexSessions,
  findLocalCursorSessions,
  loadCodexGraph,
  loadCursorGraph,
  sniffScheme,
} from './sessionProviders';

export interface LocalSession {
  scheme: AgentScheme;
  sessionId: string;
  jsonlPath: string;
  projectSlug: string;
  mtime: number;
  preview: string;
}

/** Local sessions across every provider, newest first (docs/spec/session-providers.md). */
export function findLocalSessions(limit = 100): LocalSession[] {
  const results: LocalSession[] = [
    ...findLocalClaudeSessions(),
    ...codexLocalSessions(),
    ...cursorLocalSessions(),
  ];
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

function codexLocalSessions(): LocalSession[] {
  return findLocalCodexSessions().map((s) => ({
    scheme: 'codex' as const,
    sessionId: s.sessionId,
    jsonlPath: s.jsonlPath,
    projectSlug: 'codex',
    mtime: s.mtime,
    preview: firstUserText(s.jsonlPath),
  }));
}

function cursorLocalSessions(): LocalSession[] {
  // Prefer the name Cursor shows in its own sidebar — that is what the user is
  // looking at when they go hunting for a session — and fall back to the first
  // prompt when the state DB is unreadable.
  const names = cursorChatNames();
  return findLocalCursorSessions().map((s) => ({
    scheme: 'cursor' as const,
    sessionId: s.sessionId,
    jsonlPath: s.jsonlPath,
    projectSlug: 'cursor',
    mtime: s.mtime,
    preview: names.get(s.sessionId) || firstUserText(s.jsonlPath),
  }));
}

/** Scan ~/.claude/projects for local Claude Code sessions. */
function findLocalClaudeSessions(): LocalSession[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const results: LocalSession[] = [];
  if (!fs.existsSync(projectsDir)) return results;
  for (const slug of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, slug);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const jsonlPath = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(jsonlPath);
      } catch {
        continue;
      }
      results.push({
        scheme: 'claude',
        sessionId: entry.replace(/\.jsonl$/, ''),
        jsonlPath,
        projectSlug: slug,
        mtime: stat.mtimeMs,
        preview: firstUserText(jsonlPath),
      });
    }
  }
  return results;
}

/**
 * Preview line for the session picker: the first real user turn. Both providers
 * bury it — Claude behind sidechains, Codex behind the injected `developer`
 * preamble — so skip anything that opens with a `<tag>` block.
 */
function firstUserText(jsonlPath: string): string {
  try {
    const head = fs.readFileSync(jsonlPath, 'utf8').split('\n', 40);
    for (const line of head) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);

      // Codex: the harness emits the user's turn as an event_msg.
      if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        const text = String(entry.payload.message ?? '');
        if (text && !text.startsWith('<')) return text.slice(0, 120);
        continue;
      }

      // Cursor: {role, message} with no type, and the prompt is wrapped in
      // <user_query> next to a <timestamp> block.
      if (entry.role === 'user' && entry.message && !entry.uuid) {
        const raw = flattenText(entry.message.content);
        const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(raw);
        const text = (q ? q[1] : raw).trim();
        if (text && !text.startsWith('<')) return text.slice(0, 120);
        continue;
      }

      if (entry.type === 'user' && !entry.isSidechain) {
        const text = flattenText(entry.message?.content);
        if (text && !text.startsWith('<')) return text.slice(0, 120);
      }
    }
  } catch {
    /* unreadable session — show id only */
  }
  return '';
}

/**
 * Copy a session (and its subagent transcripts, using the
 * `<sessionId>/subagents/agent-<id>.jsonl` convention) into
 * `.comments/sessions/` so conversation links work for anyone
 * who clones the repo.
 */
export function vendorSession(src: LocalSession, sessionsDir: string): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.copyFileSync(src.jsonlPath, path.join(sessionsDir, src.sessionId + '.jsonl'));
  const subagentsSrc = path.join(path.dirname(src.jsonlPath), src.sessionId, 'subagents');
  if (fs.existsSync(subagentsSrc)) {
    const subagentsDst = path.join(sessionsDir, src.sessionId, 'subagents');
    fs.mkdirSync(subagentsDst, { recursive: true });
    for (const f of fs.readdirSync(subagentsSrc)) {
      if (f.endsWith('.jsonl')) {
        fs.copyFileSync(path.join(subagentsSrc, f), path.join(subagentsDst, f));
      }
    }
  }
}

export function vendoredSessionPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, sessionId + '.jsonl');
}

/**
 * Locate the message where an agent wrote a given comment: scan the vendored
 * transcript for the comments-MCP tool call whose input.body matches. Lets the
 * Sessions menu deep-link the exact PORTION of a session behind each reply
 * (claude:<sid>#<uuid>) without any extra bookkeeping at write time.
 */
export function findReplyFocusUuid(
  sessionsDir: string,
  sessionId: string,
  commentBody: string,
): string | undefined {
  return findReplySegment(sessionsDir, sessionId, commentBody)?.to;
}

/**
 * The PORTION of a session behind a comment: from the first message after the
 * previous comments-MCP write (or the session start) to the write that
 * produced this comment. Yields a copy-pastable claude:<sid>#<from>..<to> ref.
 */
export function findReplySegment(
  sessionsDir: string,
  sessionId: string,
  commentBody: string,
): { from: string; to: string } | undefined {
  const jsonlPath = vendoredSessionPath(sessionsDir, sessionId);
  if (!fs.existsSync(jsonlPath)) return undefined;
  const isCommentsWrite = (c: any) =>
    c?.type === 'tool_use' &&
    typeof c.name === 'string' &&
    /(reply_to_thread|create_thread|attach_suggestion|resolve_thread)$/.test(c.name);

  let segmentStart: string | undefined;
  for (const entry of readJsonl(jsonlPath)) {
    const content = entry?.message?.content;
    if (typeof entry?.uuid !== 'string') continue;
    if (segmentStart === undefined) segmentStart = entry.uuid;
    if (!Array.isArray(content)) continue;
    const writes = content.filter(isCommentsWrite);
    if (writes.some((c: any) => c.input?.body === commentBody)) {
      return { from: segmentStart ?? entry.uuid, to: entry.uuid };
    }
    if (writes.length > 0) {
      segmentStart = undefined; // next entry starts the next segment
    }
  }
  return undefined;
}

/** Parse a vendored session JSONL into the graph model the webview renders. */
export function loadSessionGraph(sessionsDir: string, sessionId: string): SessionGraph | undefined {
  const jsonlPath = vendoredSessionPath(sessionsDir, sessionId);
  if (!fs.existsSync(jsonlPath)) return undefined;
  const scheme = sniffScheme(jsonlPath);
  if (scheme === 'codex') return loadCodexGraph(jsonlPath, sessionId);
  if (scheme === 'cursor') return loadCursorGraph(jsonlPath, sessionId);

  const entries = readJsonl(jsonlPath);
  const messages: GraphMessage[] = [];
  const byUuid = new Map<string, GraphMessage>();
  const toolUseToSpawner = new Map<string, string>(); // tool_use_id -> assistant uuid
  const taskInputs = new Map<string, { description: string; agentType: string }>();
  const subagents = new Map<string, SubagentInfo>();

  // Session files interleave meta entries (last-prompt, mode, attachment,
  // ai-title, file-history-*, queue-operation, pr-link, …). We drop them but
  // parentUuid chains often route *through* them, so resolve each kept
  // message's parent to its nearest kept ancestor.
  const rawParent = new Map<string, string | null>();
  const kept = new Set<string>();
  const isConvo = (e: any) =>
    e.uuid && !e.isSidechain && (e.type === 'user' || e.type === 'assistant' || e.type === 'system');
  for (const entry of entries) {
    if (!entry.uuid) continue;
    rawParent.set(entry.uuid, entry.parentUuid ?? null);
    if (isConvo(entry)) kept.add(entry.uuid);
  }
  const nearestKeptAncestor = (uuid: string | null): string | null => {
    let cur = uuid;
    for (let hops = 0; cur && hops < 10000; hops++) {
      if (kept.has(cur)) return cur;
      cur = rawParent.get(cur) ?? null;
    }
    return null;
  };

  let prevUuid: string | null = null;
  for (const entry of entries) {
    if (!isConvo(entry)) continue;
    const role: GraphMessage['role'] = entry.type;
    const toolUses: GraphToolUse[] = [];
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use') {
          toolUses.push({
            id: block.id ?? '',
            name: block.name ?? 'tool',
            summary: summarizeToolInput(block.name, block.input),
          });
          toolUseToSpawner.set(block.id, entry.uuid);
          if (block.name === 'Task' || block.name === 'Agent') {
            taskInputs.set(block.id, {
              description: block.input?.description ?? '',
              agentType: block.input?.subagent_type ?? block.input?.agentType ?? '',
            });
          }
        }
      }
    }
    const msg: GraphMessage = {
      uuid: entry.uuid,
      // Fall back to sequential chaining for sessions without parentUuid.
      parentUuid:
        entry.parentUuid !== undefined ? nearestKeptAncestor(entry.parentUuid) : prevUuid,
      role,
      timestamp: entry.timestamp ?? '',
      text: flattenText(content),
      toolUses,
      spawns: [],
    };

    // Subagent linkage: tool_result carrying toolUseResult.agentId.
    const agentId = entry.toolUseResult?.agentId;
    if (agentId && Array.isArray(content)) {
      const resultBlock = content.find((b: any) => b?.type === 'tool_result');
      const spawnUuid = resultBlock ? toolUseToSpawner.get(resultBlock.tool_use_id) ?? null : null;
      const task = resultBlock ? taskInputs.get(resultBlock.tool_use_id) : undefined;
      subagents.set(agentId, {
        agentId,
        spawnUuid,
        description: task?.description ?? entry.toolUseResult.description ?? '',
        agentType: entry.toolUseResult.agentType ?? task?.agentType ?? '',
        totalDurationMs: entry.toolUseResult.totalDurationMs,
        totalTokens: entry.toolUseResult.totalTokens,
        totalToolUseCount: entry.toolUseResult.totalToolUseCount,
        resultPreview: flattenText(entry.toolUseResult.content).slice(0, 500),
        messages: [],
      });
      if (spawnUuid) {
        const spawner = byUuid.get(spawnUuid);
        if (spawner) spawner.spawns.push(agentId);
      }
    }

    messages.push(msg);
    byUuid.set(msg.uuid, msg);
    prevUuid = msg.uuid;
  }

  // Load subagent transcripts vendored alongside the session.
  const subDir = path.join(sessionsDir, sessionId, 'subagents');
  for (const info of subagents.values()) {
    const p = path.join(subDir, `agent-${info.agentId}.jsonl`);
    if (fs.existsSync(p)) {
      info.messages = readJsonl(p)
        .filter((e) => e.uuid && (e.type === 'user' || e.type === 'assistant'))
        .map((e) => ({
          uuid: e.uuid,
          parentUuid: e.parentUuid ?? null,
          role: e.type,
          timestamp: e.timestamp ?? '',
          text: flattenText(e.message?.content),
          toolUses: Array.isArray(e.message?.content)
            ? e.message.content
                .filter((b: any) => b?.type === 'tool_use')
                .map((b: any) => ({
                  id: b.id ?? '',
                  name: b.name ?? 'tool',
                  summary: summarizeToolInput(b.name, b.input),
                }))
            : [],
          spawns: [],
        }));
    }
  }

  const { mainPath, forks } = computePaths(messages);
  const title = messages.find((m) => m.role === 'user' && m.text)?.text.slice(0, 80) ?? sessionId;
  return {
    scheme: 'claude',
    sessionId,
    title,
    messages,
    mainPath,
    forks,
    subagents: [...subagents.values()],
  };
}

/**
 * Main path vs forks in the parentUuid forest. A session can hold several
 * trees (continuation/compaction restarts the chain), so each root — in file
 * order — contributes one sequential segment of the spine. Within a tree, the
 * tip is the last tree member in file order; walking its parent chain gives
 * that segment's main path. Any subtree hanging off a main-path node that
 * isn't on the path is an abandoned fork (message edits / retries).
 */
function computePaths(messages: GraphMessage[]): { mainPath: string[]; forks: Fork[] } {
  if (messages.length === 0) return { mainPath: [], forks: [] };
  const byUuid = new Map(messages.map((m) => [m.uuid, m]));
  const children = new Map<string, string[]>();
  const roots: GraphMessage[] = [];
  for (const m of messages) {
    if (m.parentUuid && byUuid.has(m.parentUuid)) {
      const list = children.get(m.parentUuid) ?? [];
      list.push(m.uuid);
      children.set(m.parentUuid, list);
    } else {
      roots.push(m);
    }
  }

  // Assign every message to its root's tree.
  const treeOf = new Map<string, string>();
  for (const root of roots) {
    const stack = [root.uuid];
    while (stack.length) {
      const u = stack.pop()!;
      treeOf.set(u, root.uuid);
      stack.push(...(children.get(u) ?? []));
    }
  }

  const mainPath: string[] = [];
  const onMain = new Set<string>();
  for (const root of roots) {
    // Tip of this tree = its last member in file order (the surviving branch).
    let tip: GraphMessage | undefined;
    for (const m of messages) {
      if (treeOf.get(m.uuid) === root.uuid) tip = m;
    }
    const segment: string[] = [];
    for (let cur: GraphMessage | undefined = tip; cur; ) {
      segment.unshift(cur.uuid);
      onMain.add(cur.uuid);
      cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
    }
    mainPath.push(...segment);
  }

  const forks: Fork[] = [];
  for (const uuid of mainPath) {
    for (const child of children.get(uuid) ?? []) {
      if (onMain.has(child)) continue;
      const branch: string[] = [];
      const stack = [child];
      while (stack.length) {
        const u = stack.shift()!;
        branch.push(u);
        stack.push(...(children.get(u) ?? []));
      }
      forks.push({ fromUuid: uuid, uuids: branch });
    }
  }
  return { mainPath, forks };
}

function readJsonl(p: string): any[] {
  const out: any[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* tolerate torn lines */
    }
  }
  return out;
}

export function flattenText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text') return block.text ?? '';
        if (block?.type === 'tool_result') return flattenText(block.content);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function summarizeToolInput(name: string, input: any): string {
  if (!input) return '';
  const value =
    input.description ?? input.command ?? input.pattern ?? input.file_path ?? input.prompt ?? '';
  return String(value).slice(0, 100);
}
