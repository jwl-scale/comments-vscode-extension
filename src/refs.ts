/** Ref syntax shared by the linkifier, preview, and tests. No vscode imports. */

// A file ref is linkable when it's unambiguous: it has a dot-extension, OR a
// directory separator (`mcpx-go/Dockerfile:1-2`), OR is a well-known
// extensionless filename. Bare `word:12` stays plain text.
const KNOWN_BARE =
  'Dockerfile|Containerfile|Makefile|makefile|Justfile|justfile|Rakefile|Gemfile|Procfile|Vagrantfile|Caddyfile|Brewfile|LICENSE|CODEOWNERS';

export const FILE_REF = new RegExp(
  String.raw`(?<![\w"'` +
    '`' +
    String.raw`/.])((?:[\w.\-]+\/)+[\w.\-]+|[\w\-]+\.[A-Za-z][A-Za-z0-9]{0,7}|(?:${KNOWN_BARE})):(\d+)(?:-(\d+))?`,
  'g',
);

// Agent-session refs (docs/spec/session-providers.md):
//   <scheme>:<sessionId>                    whole conversation
//   <scheme>:<sessionId>#<msgUuid>          focused on one message
//   <scheme>:<sessionId>#<uuid1>..<uuid2>   focused on a message range
//   <scheme>:<sessionId>@<agentId>          focused on a subagent
export const AGENT_SCHEMES = ['claude', 'codex'] as const;
export type AgentScheme = (typeof AGENT_SCHEMES)[number];

/**
 * Linkification requires an explicit scheme. The spec's "bare ref means claude"
 * rule is for trailers and actor.session fields (structured positions), NOT for
 * prose — matching bare `<sid>#<uuid>` in a comment body would link half the
 * hex strings people paste. Use parseSessionRef for the structured positions.
 */
export const AGENT_REF = new RegExp(
  String.raw`(${AGENT_SCHEMES.join('|')}):([A-Za-z0-9\-_]+)(?:#([A-Za-z0-9\-_]+)(?:\.\.([A-Za-z0-9\-_]+))?|@([A-Za-z0-9\-_]+))?`,
  'g',
);

/** @deprecated pre-v0.12 name; scheme-blind. Kept so out/ consumers keep compiling. */
export const CLAUDE_REF =
  /claude:([A-Za-z0-9\-_]+)(?:#([A-Za-z0-9\-_]+)(?:\.\.([A-Za-z0-9\-_]+))?|@([A-Za-z0-9\-_]+))?/g;

export interface SessionRef {
  scheme: AgentScheme;
  sessionId: string;
  msgUuid?: string;
  rangeEnd?: string;
  agentId?: string;
}

const SESSION_REF_EXACT = new RegExp(
  String.raw`^(?:([a-z][a-z0-9-]{0,15}):)?([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+)(?:\.\.([A-Za-z0-9_-]+))?|@([A-Za-z0-9_-]+))?$`,
);

/**
 * Parse a session ref from a structured position (a commit trailer value, an
 * actor.session field). An absent scheme means `claude` — the compatibility
 * rule that keeps every ref written before v0.12 valid. Unknown schemes return
 * null rather than being coerced: a provider must not guess at another's ids.
 */
export function parseSessionRef(raw: string): SessionRef | null {
  const m = SESSION_REF_EXACT.exec(raw.trim());
  if (!m) return null;
  const scheme = (m[1] ?? 'claude') as AgentScheme;
  if (!AGENT_SCHEMES.includes(scheme)) return null;
  return {
    scheme,
    sessionId: m[2],
    msgUuid: m[3] || undefined,
    rangeEnd: m[4] || undefined,
    agentId: m[5] || undefined,
  };
}

/** Render a ref for writing. Always scheme-qualified (spec: writers MUST emit it). */
export function formatSessionRef(ref: SessionRef): string {
  const suffix = ref.agentId
    ? `@${ref.agentId}`
    : ref.msgUuid
      ? ref.rangeEnd
        ? `#${ref.msgUuid}..${ref.rangeEnd}`
        : `#${ref.msgUuid}`
      : '';
  return `${ref.scheme}:${ref.sessionId}${suffix}`;
}

// thread:<threadId>               a whole comment thread (any file)
// thread:<threadId>#<commentId>   one comment within it
export const THREAD_REF = /(?<![\w:])thread:(th_[A-Za-z0-9-]+)(?:#(c_[A-Za-z0-9-]+))?/g;

// Mentions in comment bodies (docs/spec: Phase 2 agent loop):
//   @<agent-name>                    dispatch the named agent (.claude/agents/<name>.md)
//   @claude | @codex                 dispatch that provider's default agent
//   @<scheme>:<sid>[#<uuid>]         fork that session (at that message) to address the thread
export type Mention =
  | { kind: 'agent'; name: string }
  | { kind: 'session'; scheme: AgentScheme; sessionId: string; messageUuid?: string };

const SESSION_MENTION = new RegExp(
  String.raw`@(${AGENT_SCHEMES.join('|')}):([A-Za-z0-9\-_]+)(?:#([A-Za-z0-9\-_]+))?`,
  'g',
);
const AGENT_MENTION = /(?<![\w@.:/])@([A-Za-z][A-Za-z0-9-]{0,63})(?![\w:@/-])/g;

/** Extract mentions from a comment body. Session mentions win over the bare `@claude`. */
export function parseMentions(body: string): Mention[] {
  const out: Mention[] = [];
  const sessionSpans: Array<[number, number]> = [];
  for (const m of body.matchAll(SESSION_MENTION)) {
    out.push({
      kind: 'session',
      scheme: m[1] as AgentScheme,
      sessionId: m[2],
      messageUuid: m[3] || undefined,
    });
    sessionSpans.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of body.matchAll(AGENT_MENTION)) {
    const start = m.index!;
    if (sessionSpans.some(([s, e]) => start >= s && start < e)) continue;
    out.push({ kind: 'agent', name: m[1] });
  }
  return out;
}

export type ConversationFocus =
  | { kind: 'msg'; uuid: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'agent'; agentId: string }
  | null;

export function focusFromMatch(
  msgUuid?: string,
  rangeEnd?: string,
  agentId?: string,
): ConversationFocus {
  if (agentId) return { kind: 'agent', agentId };
  if (msgUuid && rangeEnd) return { kind: 'range', from: msgUuid, to: rangeEnd };
  if (msgUuid) return { kind: 'msg', uuid: msgUuid };
  return null;
}
