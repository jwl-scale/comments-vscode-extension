/**
 * Which agent sessions relate to a thread, and how. Three relationships:
 *   current    — the sticky session ▶ would continue (latest actor.session)
 *   provenance — sessions that produced specific comments (actor.session stamps)
 *   reference  — claude:/codex: refs typed/pasted into comment bodies (may carry
 *                message/range/agent focus already)
 * Sessions are identified by scheme AND id: two providers' id spaces are
 * independent, so `claude:abc` and `codex:abc` are different conversations.
 * No vscode imports — tested directly from out/.
 */

import { AGENT_REF, AgentScheme, ConversationFocus, focusFromMatch, parseSessionRef } from './refs';
import { lastSessionId } from './agentArgs';
import { ThreadState } from './threadLog';

export interface SessionComment {
  commentId: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface SessionRef {
  raw: string;
  focus: ConversationFocus;
}

export interface ThreadSessionInfo {
  scheme: AgentScheme;
  sessionId: string;
  /** ▶ would continue this session. */
  isCurrent: boolean;
  /** Comments this session produced (actor.session provenance). */
  comments: SessionComment[];
  /** Explicit claude:/codex: references in comment bodies, with their focus. */
  refs: SessionRef[];
}

export function collectThreadSessions(state: ThreadState): ThreadSessionInfo[] {
  const byId = new Map<string, ThreadSessionInfo>();
  const get = (scheme: AgentScheme, sessionId: string): ThreadSessionInfo => {
    const key = `${scheme}:${sessionId}`;
    let info = byId.get(key);
    if (!info) {
      info = { scheme, sessionId, isCurrent: false, comments: [], refs: [] };
      byId.set(key, info);
    }
    return info;
  };

  for (const c of state.comments) {
    if (c.deleted) continue;
    if (c.session) {
      // actor.session is a structured position: an unscheme'd value means claude.
      const ref = parseSessionRef(c.session);
      if (ref) {
        get(ref.scheme, ref.sessionId).comments.push({
          commentId: c.id,
          author: c.author,
          body: c.body,
          createdAt: c.createdAt,
        });
      }
    }
    for (const m of c.body.matchAll(AGENT_REF)) {
      get(m[1] as AgentScheme, m[2]).refs.push({ raw: m[0], focus: focusFromMatch(m[3], m[4], m[5]) });
    }
  }

  const current = lastSessionId(state.events);
  if (current) {
    const ref = parseSessionRef(current);
    if (ref) get(ref.scheme, ref.sessionId).isCurrent = true;
  }

  // Current first, then by most recent activity.
  return [...byId.values()].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const lastA = a.comments[a.comments.length - 1]?.createdAt ?? '';
    const lastB = b.comments[b.comments.length - 1]?.createdAt ?? '';
    return lastB.localeCompare(lastA);
  });
}
