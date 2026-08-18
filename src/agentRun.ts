import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { Actor, ThreadState, liveClaim } from './threadLog';
import { BuiltRun, RunOptions, buildAgentArgs, buildCodexArgs, codexSessionIdFromEvent, lastSessionId } from './agentArgs';
import { AgentScheme, Mention, parseMentions, parseSessionRef } from './refs';
import { agentCommand, agentProvider } from './agentConfig';
import { Store } from './store';
import { findLocalSessions, vendorSession } from './sessions';

/**
 * Assign-to-Claude (Phase 2 agent loop): claim the thread, run a headless
 * `claude -p` with the thread as context and the comments MCP server wired in,
 * then vendor the resulting session and attach it as a claude: chip. Mentions
 * in the latest comment steer the run: @<agent-name> applies an agent
 * definition from .claude/agents/, @claude:<sid>[#<uuid>] forks that session.
 */

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
}

/** Agent definitions from <repo>/.claude/agents/*.md and ~/.claude/agents/*.md. */
export function findAgentDefinitions(repoRoot: string): AgentDefinition[] {
  const out = new Map<string, AgentDefinition>();
  for (const dir of [path.join(os.homedir(), '.claude', 'agents'), path.join(repoRoot, '.claude', 'agents')]) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const raw = fs.readFileSync(path.join(dir, entry), 'utf8');
        const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        const front = fm?.[1] ?? '';
        const body = (fm?.[2] ?? raw).trim();
        const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim() || entry.slice(0, -3);
        const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
        out.set(name, { name, description, systemPrompt: body }); // repo defs override ~/.claude
      } catch {
        /* skip unreadable definition */
      }
    }
  }
  return [...out.values()];
}

export interface RunPlan {
  agent?: AgentDefinition;
  forkSessionId?: string;
  mentions: Mention[];
  forkSessionScheme?: AgentScheme;
}

/** Steering: mentions in the newest comment win; falls back to the default agent. */
export function planFromThread(state: ThreadState, agents: AgentDefinition[]): RunPlan {
  const visible = state.comments.filter((c) => !c.deleted);
  const mentions = parseMentions(visible[visible.length - 1]?.body ?? '');
  const session = mentions.find((m) => m.kind === 'session');
  const agentMention = mentions.find(
    (m) => m.kind === 'agent' && m.name !== 'claude' && m.name !== 'codex',
  );
  return {
    agent: agentMention ? agents.find((a) => a.name === (agentMention as { name: string }).name) : undefined,
    forkSessionId: session?.kind === 'session' ? session.sessionId : undefined,
    forkSessionScheme: session?.kind === 'session' ? session.scheme : undefined,
    mentions,
  };
}

/**
 * A stored `actor.session` is a scheme-qualified ref, but a CLI wants a bare
 * id — and one provider cannot resume another's session, so a ref from the
 * other provider means "no session to continue" rather than an error.
 */
function sessionIdForProvider(ref: string | undefined, provider: AgentScheme): string | undefined {
  if (!ref) return undefined;
  const parsed = parseSessionRef(ref);
  return parsed && parsed.scheme === provider ? parsed.sessionId : undefined;
}

export function buildPrompt(state: ThreadState, repoRoot: string): string {
  const visible = state.comments.filter((c) => !c.deleted);
  const transcript = visible.map((c) => `- ${c.author} (${c.createdAt}): ${c.body}`).join('\n');
  return [
    `You are addressing a code-review comment thread in the repository at ${repoRoot}.`,
    '',
    `Thread ${state.id} — ${state.file}, lines ${state.anchor.start.line + 1}-${state.anchor.end.line + 1} (severity: ${state.severity}).`,
    'Anchored code:',
    '```',
    state.anchor.text,
    '```',
    'Discussion so far:',
    transcript,
    '',
    'Instructions:',
    `1. Investigate the surrounding code with your read-only tools before answering.`,
    `2. Reply to the thread via the comments MCP tool reply_to_thread (threadId "${state.id}"). Be substantive: state what you found and why.`,
    `3. If a code change is warranted, express it as a unified diff (git-style a/ b/ paths, correct hunk headers) and attach it with attach_suggestion. Do NOT modify files in the working tree — a human reviews and applies suggestions.`,
    `4. Only resolve_thread (reason "fixed") if your reply and suggestion fully address the comment; if the comment looks stale or obsolete, say so in a reply and leave resolution to a human.`,
  ].join('\n');
}

export interface AgentRunResult {
  ok: boolean;
  sessionId?: string;
  error?: string;
}

export async function runAgentOnThread(
  store: Store,
  state: ThreadState,
  serverPath: string,
  token: vscode.CancellationToken,
  log: (line: string) => void,
  options: RunOptions & { agentName?: string } = {},
): Promise<AgentRunResult> {
  const root = store.liveRoot();
  if (!root) return { ok: false, error: 'no workspace root' };

  const agents = findAgentDefinitions(root);
  const plan = planFromThread(state, agents);
  // Explicit ⚙ agent choice beats mention-derived; both beat plain claude.
  const chosenAgent = options.agentName ? agents.find((a) => a.name === options.agentName) : plan.agent;
  const actorName = chosenAgent?.name ?? 'claude';
  const actor: Actor = { name: actorName, kind: 'agent' };

  // Advisory lease: at most one active fixer per thread.
  const existing = liveClaim(state);
  if (existing && existing.actor.name !== actorName) {
    return { ok: false, error: `thread is claimed by ${existing.actor.name}` };
  }
  store.append(state.id, actor, 'claimed', { ttlSeconds: 3600 });

  const config = vscode.workspace.getConfiguration('mdComments');
  const provider = agentProvider();
  const command = agentCommand(provider);

  const buildParams = {
    prompt: buildPrompt(state, root),
    options,
    agentSystemPrompt: chosenAgent?.systemPrompt,
    // Both are bare ids for the CURRENT provider, or undefined: resuming a
    // codex session with the claude CLI (or the reverse) is not a thing.
    mentionSessionId:
      plan.forkSessionScheme && plan.forkSessionScheme !== provider ? undefined : plan.forkSessionId,
    threadLastSessionId: sessionIdForProvider(lastSessionId(state.events), provider),
    newSessionId: randomUUID(),
  };

  let decision: BuiltRun;
  let args: string[];
  let sessionMode: BuiltRun['sessionMode'];
  // Late-bound session stamping (codex only): a file the MCP server re-reads on
  // every write, which we fill the instant the run announces its id. See
  // currentSessionRef() in bin/mcp-comments.js.
  let sessionFile: string | undefined;
  if (provider === 'codex') {
    // Codex cannot be handed a session id up front: `codex exec` has no
    // --session-id, and the id only exists once the process emits
    // `thread.started`. Passing MD_COMMENTS_SESSION would therefore stamp
    // nothing on a fresh run, and every agent reply would land without
    // provenance. Hand the server a path instead and fill it from the stream.
    const built = buildCodexArgs({ ...buildParams, mcpServerPath: serverPath });
    decision = built;
    sessionMode = built.sessionMode;
    sessionFile = path.join(os.tmpdir(), `mdc-session-${randomUUID()}`);
    const knownRef = built.knownSessionId ? `codex:${built.knownSessionId}` : undefined;
    if (knownRef) {
      // Resuming: the id is known now, so seed the file immediately rather than
      // waiting for the stream to repeat it.
      try {
        fs.writeFileSync(sessionFile, knownRef);
      } catch {
        /* stamping degrades to unstamped; the run itself is unaffected */
      }
    }
    args = [
      ...built.args.slice(0, -1),
      '-c',
      `mcp_servers.comments.env.MD_COMMENTS_ROOT="${root}"`,
      '-c',
      `mcp_servers.comments.env.MD_COMMENTS_SESSION_FILE="${sessionFile}"`,
      built.args[built.args.length - 1],
    ];
  } else {
    // Two-pass build: the session decision (fresh/continue/fork) determines the
    // id the MCP server stamps onto agent writes, and that env var lives inside
    // the --mcp-config argument — so decide first, then build the real args.
    decision = buildAgentArgs({ ...buildParams, mcpConfigJson: '' });
    const mcpConfig = JSON.stringify({
      mcpServers: {
        comments: {
          command: process.execPath,
          args: [serverPath],
          env: {
            MD_COMMENTS_ROOT: root,
            ...(decision.knownSessionId ? { MD_COMMENTS_SESSION: `claude:${decision.knownSessionId}` } : {}),
          },
        },
      },
    });
    ({ args, sessionMode } = buildAgentArgs({ ...buildParams, mcpConfigJson: mcpConfig }));
  }

  const modeNote =
    sessionMode === 'continue'
      ? ` (continuing ${decision.knownSessionId!.slice(0, 8)})`
      : sessionMode === 'fork'
        ? ` (forking ${(plan.forkSessionId ?? '').slice(0, 8)})`
        : '';
  log(`dispatching ${actorName}${modeNote} on ${state.id}`);
  const result = await new Promise<AgentRunResult>((resolve) => {
    const proc = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    let sessionId: string | undefined = decision.knownSessionId;
    let resultError: string | undefined;
    const onLine = (line: string) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (!ev || typeof ev !== 'object') return;
      if (ev.session_id) sessionId = ev.session_id;
      if (provider === 'codex') {
        const found = codexSessionIdFromEvent(line);
        if (found && found !== sessionId) {
          sessionId = found;
          // `thread.started` is the first line of the stream, so this lands
          // before the model can call a tool: writes are stamped from the
          // very first one.
          if (sessionFile) {
            try {
              fs.writeFileSync(sessionFile, `codex:${found}`);
            } catch {
              log(`could not record session id for stamping (${found})`);
            }
          }
        }
        const payload = ev.payload;
        if (payload?.type === 'patch_apply_end') {
          for (const f of Object.keys(payload.changes ?? {})) log(`⚙ apply_patch ${f}`);
        }
        return;
      }
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const c of ev.message.content) {
          if (c?.type === 'tool_use') log(`⚙ ${c.name}${c.input?.file_path ? ` ${c.input.file_path}` : ''}`);
        }
      } else if (ev.type === 'result') {
        if (ev.is_error) resultError = String(ev.result ?? ev.subtype ?? 'agent error').slice(0, 400);
      }
    };
    proc.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    proc.stderr.on('data', (c: Buffer) => (err += c.toString()));
    token.onCancellationRequested(() => proc.kill());
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim());
      // The MCP server is gone with the run; the late-binding file has no
      // further readers.
      if (sessionFile) {
        try {
          fs.rmSync(sessionFile, { force: true });
        } catch {
          /* a stray temp file is not worth failing a landed run over */
        }
      }
      if (token.isCancellationRequested) return resolve({ ok: false, error: 'cancelled' });
      if (code !== 0 || resultError) {
        return resolve({ ok: false, sessionId, error: resultError || err.trim().slice(0, 400) || `exit ${code}` });
      }
      resolve({ ok: true, sessionId });
    });
  });

  // Provenance: vendor the session; the agent's own replies carry it via
  // actor.session (stamped by the MCP server), so a separate chip comment is
  // only appended when no stamped reply landed (fork runs, silent runs, failures).
  if (result.sessionId) {
    const dir = store.sessionsDir();
    if (dir) {
      const local = findLocalSessions(1000).find((s) => s.sessionId === result.sessionId);
      if (local) {
        try {
          vendorSession(local, dir);
        } catch {
          log(`could not vendor session ${result.sessionId}`);
        }
      }
    }
    const after = store.getThread(state.id);
    const stampedReply = after?.events.some(
      (e) => e.type === 'replied' && (e.actor as Actor | undefined)?.session === result.sessionId,
    );
    if (!stampedReply || !result.ok) {
      store.append(state.id, { ...actor, session: result.sessionId }, 'replied', {
        commentId: `c_${randomUUID()}`,
        body: result.ok
          ? `Attached conversation: ${provider}:${result.sessionId}`
          : `Agent run failed (${result.error}). Partial conversation: ${provider}:${result.sessionId}`,
      });
    }
  } else if (!result.ok) {
    store.append(state.id, actor, 'replied', {
      commentId: `c_${randomUUID()}`,
      body: `Agent run failed: ${result.error}`,
    });
  }
  store.append(state.id, actor, 'released', {});
  log(result.ok ? `done (session ${result.sessionId ?? 'unknown'})` : `failed: ${result.error}`);
  return result;
}

