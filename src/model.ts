/** Persisted data model — everything under `.comments/` is this shape. */

export interface Anchor {
  /** 0-based positions captured at comment time. Best-effort hints, not truth. */
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  /** Exact selected text at creation — primary re-anchoring key. */
  text: string;
  /** Up to 120 chars of surrounding context for disambiguation. */
  prefix: string;
  suffix: string;
}

export interface StoredComment {
  id: string;
  author: string;
  /** Raw markdown. May contain `path/file.ts:12-34` and `claude:<sessionId>[#<msgUuid>]` refs. */
  body: string;
  createdAt: string;
}

export interface StoredThread {
  id: string;
  status: 'open' | 'resolved';
  anchor: Anchor;
  comments: StoredComment[];
}

export interface SidecarFile {
  version: 1;
  /** Workspace-relative posix path of the commented file. */
  file: string;
  threads: StoredThread[];
}

/** Parsed Claude Code session, ready for the graph webview. */

export interface GraphToolUse {
  id: string;
  name: string;
  summary: string;
}

export interface GraphMessage {
  uuid: string;
  parentUuid: string | null;
  role: 'user' | 'assistant' | 'system' | 'other';
  timestamp: string;
  /** Flattened text preview (full text; webview truncates for display). */
  text: string;
  toolUses: GraphToolUse[];
  /** agentIds spawned by this message's Task tool calls (resolved via toolUseResult). */
  spawns: string[];
}

export interface SubagentInfo {
  agentId: string;
  spawnUuid: string | null;
  description: string;
  agentType: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  resultPreview: string;
  messages: GraphMessage[];
}

export interface Fork {
  /** uuid of the main-path message this branch diverges from (its parent). */
  fromUuid: string;
  /** Branch messages in DFS/chronological order. */
  uuids: string[];
}

export interface SessionGraph {
  sessionId: string;
  title: string;
  messages: GraphMessage[];
  /** uuids in order along the main (surviving) path. */
  mainPath: string[];
  forks: Fork[];
  subagents: SubagentInfo[];
}
