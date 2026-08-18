# Changelog

Versions below 1.0.0 predate the Marketplace listing: they were developed and
dogfooded in a private repository, and are kept here because the reasoning
behind each change is the point of this project. 1.0.0 is the first public
release, not the first working one.

## 1.0.1 — 2026-08-18

**Codex agent sessions are attributed again.** Claude is handed a session id before it starts
(`--session-id`), so the comments MCP server can be told whose session it serves at spawn time. Codex has no
such flag — its id does not exist until the run announces `thread.started` — and 1.0.0 shipped accepting that,
leaving fresh Codex runs unstamped. Everything keyed on `actor.session` silently degraded: per-comment
provenance, sticky per-thread sessions, and the Sessions menu.

The runner now passes `MD_COMMENTS_SESSION_FILE` and fills it the instant the id appears on the event stream —
the first line, before the model can call a tool — and the server re-reads it per write. A file that does not
parse as a session ref is never stamped: an appended event cannot be taken back.

Two further defects surfaced in the same area:

- The session id was **never recovered at all**: the stream parser looked for `session_id`, but Codex emits
  `thread.started` with `thread_id`. Post-run transcript vendoring and the `codex:` conversation chip were
  broken too, not just stamping.
- Stored `actor.session` values are scheme-qualified, and several paths passed them to a CLI as bare ids. They
  are parsed now, and a ref belonging to the other provider means "start a fresh session" rather than an
  error — one agent cannot resume another's conversation.

## 1.0.0 — 2026-08-17 — first public release

**Multi-agent: Codex alongside Claude Code.** Locating a transcript, naming a session, and extracting its file
mutations are now a **provider** contract (`docs/spec/session-providers.md`) rather than assumptions baked into
the notary and the editor. Everything else — anchors, event logs, the gate, landing, re-anchoring, memory — was
already provider-independent and stays that way.

- **Codex provenance**, verified the same way Claude's is: the provider reads `patch_apply_end` events, which
  record the diff Codex *actually applied* per file, and replays them against the base tree. Failed applies are
  skipped; shell/`sed` edits remain invisible and still verify `hybrid`. `Provenance: agent` is a check, never a claim.
- **`Agent-Session:` trailer** replaces `Claude-Session:`, with scheme-qualified values (`claude:<sid>#<a>..<b>`,
  `codex:<sid>#<a>..<b>`) and repeatable lines. The legacy key is still read as scheme `claude`, and bare refs in
  trailers, `actor.session` fields, and comment bodies keep resolving — published history keeps blaming correctly.
- `--session` accepts a comma-separated list: one commit may cite several sessions, across providers, and
  provenance is computed over the union of their ops.
- **Codex sessions in the editor**: rollout discovery, the Agent Sessions view, conversation rendering (a linear
  spine — Codex has no reply tree, and compaction starts a new segment), and `codex:` chips in comment bodies.
- **`codex exec` dispatch**: permission modes map onto sandbox policies, MCP is wired via `-c mcp_servers.…`
  overrides, and the session id is recovered from the `--json` event stream (Codex cannot pre-assign one).
- **`comment-cycle-codex` skill**, and **Comments: Install Agent Skill** to install either playbook — Claude reads
  workspace skills, Codex only discovers them under `$CODEX_HOME`.

**Provider-neutral surface.** `mdComments.agent.provider` and `mdComments.agent.command` replace
`mdComments.claudeCommand` (still honored, marked deprecated). Commands are renamed
`assignToClaude`→`assignToAgent`, `askClaudeFollowUp`→`askAgentFollowUp`,
`configureAssignToClaude`→`configureAssignToAgent`, `attachClaudeSession`→`attachAgentSession`; the old ids stay
registered so existing keybindings keep working.

**Marketplace readiness**: `repository`/`bugs`/`homepage`, an Apache-2.0 `LICENSE` file, an icon, real categories
and keywords, and a `.vscodeignore` that no longer ships development context.

## 0.11.0 — 2026-08-03
- **Phase 4 — blame-indexed memory**: hover chips on any line whose last-touch commit carries trailers (provenance badge, thread links, session-segment link); **Comments: Line History** walks `git log -L` ancestry joined with the conversation layer at each commit (threads-at-sha, briefs, trailers) with open-conversation/thread/brief/diff actions; new MCP tools **`get_commit_context`** (sha → trailers + brief + thread discussions, recovering pruned threads from history) and **`search_reasoning`** (query → briefs/threads/transcripts). Skill gains the *blame-before-you-change* recipe.
- **Agent-loop fixes from real-world runs**: `dispatch_agent` hands off agent-held claims to the worker (human claims never overridden) — no more doubled dispatches; provenance replay understands **MultiEdit**; `resolve_thread` is idempotent (no duplicate events after notary resolution); skill duty added — *file changes via Edit/Write/MultiEdit, not shell scripts* (side-channel edits verify `hybrid`).

## 0.10.0 — 2026-08-03
- **Agent-loop fixes from real-world runs**:
  - Provenance replay maps **worktree-absolute Edit/Write paths** by unique suffix against the candidate's changed files — agents editing in isolated worktrees (our own prescribed flow) no longer verify as `hybrid`.
  - `dispatch_agent` workers can now **see code**: default allowlist gains Read/Grep/Glob and read-only git (`git diff/show/log/blame`), plus a `diff` argument so reviewers of uncommitted/worktree candidates receive the actual change inline.
  - Dispatched workers' events are **attributed to their agent name** (`MD_COMMENTS_AUTHOR` threaded through the worker's MCP env), not `claude`.
- **Live session presence**: new `register_session` MCP tool writes to a machine-local registry (`<git-common-dir>/comments-runs/`, never committed); the new **Agent Sessions** explorer view lists working sessions (main/reviewer/implementer) with liveness derived from transcript mtime, one click opening the conversation graph — re-vendored fresh on each open so in-flight runs are watchable.
- **Skill hardened**: two new non-negotiables — *no landing without a sighted review* (a reviewer who couldn't see the diff can only rubber-stamp) and *land at thread granularity* (batching requires an in-thread justification); presence registration added to duties; parallel-recon added as advice.

## 0.9.0 — 2026-08-03
- **`dispatch_agent` MCP tool**: a main agent can spawn configured suggest-only workers on a thread over MCP — full run surface (model, effort, permission mode, system prompt, tools, sessionMode fresh/continue), returns the sessionId immediately, progress observable via thread events; claim taken on dispatch, released on exit.
- **Provenance replay merges Task-subagent transcripts** (`<sid>/subagents/agent-*.jsonl`, timestamp-ordered) — delegated edits now verify as `agent` instead of unfairly `hybrid`; segment refs stay main-transcript uuids.
- **`land --keep-conflicts`**: a conflicting rebase preserves the conflicted worktree and reports files + resume instructions, so the orchestrating model (or a human) resolves deliberately and resubmits — the notary still never auto-resolves. **`land --no-prune`** keeps resolved thread files in the working tree.
- **`comment-cycle` skill**: the orchestration playbook for a frontier main agent — building blocks, invariants, provenance duties (session-id self-registration), worker-mechanism menu, advisory recipes, autonomy knobs. Mechanisms stay dumb; composition belongs to the model.

## 0.8.0 — 2026-08-02
- **🚀 Accept & Land** on suggestion threads: `comments-queue land-suggestion` packages the open suggestion into a candidate in a scratch worktree (working tree untouched) and runs the full landing pipeline. The provenance replayer now understands `attach_suggestion` tool calls, so suggest-only agent flows verify as `Provenance: agent`.
- **Fleet dispatcher**: `comments-queue fleet --threads …` claims each thread, runs one fixer agent per thread in an isolated worktree (direct edits under `acceptEdits`, replies via MCP into the shared live store), commits each result, and lands serially through the queue with sibling threads gate-exempt. `Comments: Dispatch Fleet…` in the palette (multi-select over open threads). Reply-only and failed fixers release their claims; skipped/failed threads reported per-thread.
- New e2e coverage: land-suggestion (agent provenance via patch replay), two-thread fleet (parallel fixers → serial landings, pruned-thread history recovery), plus an extension-level integration test for Accept & Land.

## 0.7.0 — 2026-08-02
- **The notary** (`bin/comments-queue.js`, zero-dep, Phase 3 of docs/spec/notary.md):
  - `check --base --head [--allow]` — CI blocking gate: fails when an open blocking thread anchors to a touched file.
  - `land --branch --threads [--session]` — serialized landing pipeline: rebase in an isolated worktree → gate → configured checks (`.comments/queue.json`) → **provenance verification by tool-call replay** (`agent` when the diff is byte-explained by the session's Edit/Write calls, else `hybrid` with unexplained files) → commit trailers (`Comments-Resolves`, `Claude-Session: <sid>#<from>..<to>` segment, `Provenance`) → ff-merge → metadata commit (`Comments-Meta-For`) with vendored session, commit brief, `resolved(fixed, sha)`/`released` events, diff-translation re-anchor sweep (collisions flagged, never guessed), and prunes of previously-resolved threads.
  - Landings serialize via `.git/comments-queue.lock`; JSON report on stdout. v1 limits: single-commit candidates; metadata failure warns instead of rolling back.
- Five headless e2e scenarios in `tests/queue.test.js` (gate, full landing, hybrid verification, gate rejection, human provenance).

## 0.6.4 — 2026-08-02
- **Thread and comment cross-references**: new `thread:<threadId>[#<commentId>]` ref scheme, linkified everywhere bodies render (comment widgets, hovers, markdown preview popovers) as a chip showing the target's file + first-comment snippet; clicking reveals the thread expanded at its anchor. 🔗 **Copy Reference** on every comment, **Copy Thread Reference** in the thread overflow menu. One thread's comment can now reference another thread or a specific comment in it.

## 0.6.3 — 2026-08-02
- **Copy-pastable refs in the Sessions… menu**: every entry shows its `claude:` ref inline and carries a copy button — whole sessions (`claude:<sid>`) and per-reply **segments** (`claude:<sid>#<from>..<to>`, canonical range notation). Reply segments now span from the first message after the previous comments-MCP write to the write that produced the comment — the true portion of the session behind each reply — and open range-focused in the graph.

## 0.6.2 — 2026-08-02
- **🗂 Sessions… thread menu**: every Claude session related to a thread, grouped by relationship — current (▶ continues it), comment provenance (with deep links to the exact reply moment, derived by finding the MCP `reply_to_thread` call in the vendored transcript), and body references (opened with their existing focus). Multiple sessions per thread are first-class.
- New vscode-free `src/threadSessions.ts` aggregation + `findReplyFocusUuid` transcript scan, both unit-tested.

## 0.6.1 — 2026-08-02
- **System prompt: replace or append.** The ⚙ menu (and `mdComments.agent.systemPrompt`) can now set the base prompt via `--system-prompt`, not just append; agent definitions and append text still stack on top.
- **Full model catalog** in the ⚙ picker, mirroring `/model` aliases: fable, opus, sonnet, `sonnet[1m]`, haiku, opusplan, custom id — all passed through to `--model`.
- **Effort as a first-class knob** (`--effort low|medium|high`), gated by an automatic `claude --help` probe so unsupported CLI builds aren't handed a flag they'd reject (with an extra-args override for the impatient). Setting: `mdComments.agent.effort`.
- **💬 Ask Claude (Follow-up…)**: one-gesture follow-up — input box → posts your reply → choose continue / fork / fresh when the thread already has a session → dispatches.

## 0.6.0 — 2026-08-02
- **⚙ Assign to Claude (Configure Run…)** next to ▶: quick-pick menu over agent definition, session mode, model, permission mode, tool allowlist, appended system prompt, max turns, and extra CLI args. Choices persist per workspace; global defaults in `mdComments.agent.*` settings.
- **Sticky thread sessions**: follow-up assigns automatically *continue* the thread's last agent session (`--resume`, same session id, stamped replies) — a thread becomes a multi-turn conversation with its agent. Session modes: `auto` (fork mention → continue thread → fresh), `fresh`, `continue`, `fork`, with graceful degradation when there's nothing to resume.
- New vscode-free `src/agentArgs.ts` (options → CLI flags + session-mode resolution) with a unit suite; integration coverage for sticky continuation and option passthrough via the fake CLI's argv dump.

## 0.5.1 — 2026-08-02
- **Agent replies now carry their session inline**: assign-to-Claude pre-assigns the session id (`--session-id`) and passes it to the MCP server (`MD_COMMENTS_SESSION`), which stamps `actor.session` on every event the agent writes. Each agent comment renders a clickable `⇥ claude:<sid>` chip — the redundant "Attached conversation" trailing comment is only added when no stamped reply landed (forked runs, failures).
- **Live progress for agent runs**: the runner now uses `--output-format stream-json`, streaming tool-use events into the progress notification and `Comments Agent` output channel ("⚙ Read src/foo.ts", …) instead of sitting silent until the run finishes.

## 0.5.0 — 2026-08-02
- **Assign to Claude** (▶ on any open thread): advisory claim → headless `claude -p` with the thread as context and the comments MCP server injected via `--mcp-config` → agent replies in-thread → session vendored and attached as a `claude:` chip → release. Cancellable progress UI, `Comments Agent` output channel, `mdComments.claudeCommand` override.
- **Mentions** steer the run: `@<agent-name>` applies `.claude/agents/<name>.md` (repo overrides `~/.claude`) as the system prompt; `@claude:<sid>[#<uuid>]` forks that session so the agent starts with the context that wrote the code.
- **Suggestion mode**: agents attach unified-diff suggestions (`attach_suggestion`); they render inline as diff blocks with ✓ Accept (applies via `git apply`, 3-way fallback) / ✗ Reject in the thread toolbar; all recorded as events.
- **Claims and severity in the UI**: ⏳ badge while a lease is live, ⛔ badge + toggle for blocking threads.
- **MCP server grows to 10 tools**: `claim_thread` (rejects while another actor's lease is live), `release_thread`, `set_severity`, `attach_suggestion`, `re_anchor_thread` (agent-driven orphan repair, can move files).
- Thread commands (`assignToClaude`, `acceptSuggestion`, `rejectSuggestion`, `toggleBlocking`) accept `{threadId}` programmatically.
- Tests: mention grammar, claims/suggestions fold + TTL, MCP claim-conflict/suggestion/re-anchor e2e, and integration suites for the full assign-to-Claude pipeline (hermetic fake `claude` CLI) and suggestion accept/reject.

## 0.4.1 — 2026-08-02
- **Three-tier test story**: tier 2 runs the extension host in real VS Code against hermetic git fixture repos (`npm run test:integration`: lifecycle events, v1 migration, MCP hot-reload into open editors, diff re-baselining after commits, rename events); tier 3 drives desktop VS Code with Playwright (`npm run test:ui`: conversation-graph + commentable-preview webview DOM, and a select→⌘⌥M→type→submit smoke asserted against the on-disk event log). Both tiers test the shipped bundle. CI runs all tiers under xvfb.
- **Comments: Verify MCP Setup** — doctor command: live stdio roundtrip against the bundled server, plus `claude mcp list` inspection that flags missing or stale-path registrations (the install path changes on extension update).
- **Comments: Open Claude Conversation** now works from the palette with no arguments (quick-pick over vendored sessions).
- Fixes surfaced by the new tiers: lazy re-baseline now requires the buffer to byte-match the HEAD blob (stale cached documents could previously stamp wrong positions); the doctor's registration check no longer blocks the extension host.

## 0.4.0 — 2026-08-02
- **Sidecar format v2** (docs/spec/sidecar-v2.md): per-thread append-only JSONL event logs under `.comments/threads/` replace the v1 mirrored-tree JSON documents. Every mutation (reply, edit, delete, resolve with reason, reopen, re-anchor, rename, severity) is a permanent attributed event; rendered state is a deterministic fold ordered by `(seq, ts, id)` with a Lamport `seq` for clock-skew safety. Union-merge-safe across branches (`merge=union` written to `.gitattributes`); writes serialized by per-thread lockfiles.
- **Git-baselined anchors**: anchors record a baseline (HEAD commit when clean, odb blob when dirty) and resolve by exact match → deterministic diff translation (Myers) → badged fuzzy fallback → explicit orphan. Persisted positions never drift silently; threads re-baseline to the new HEAD after commits via explicit `reanchored` events.
- **One live store per repository**: all writers — extension, MCP processes, agents in linked git worktrees — resolve the primary working tree's `.comments/` via the git common dir. Agent activity in isolated worktrees is visible everywhere immediately.
- **v1 → v2 migration**: **Comments: Migrate Sidecars to v2** (offered automatically on startup); thread ids preserved, anchors re-resolved and re-baselined.
- MCP server ported to v2; `create_thread` gains `severity`, `resolve_thread` gains `reason` (fixed | stale | wontfix | obsolete).
- New vscode-free core modules (`src/threadLog.ts`, `src/baseline.ts`) with test suites; deleting a source file now resolves its threads as `obsolete` instead of erasing them.
- Design specs added under `docs/spec/`: sidecar v2, commit trailer grammar, notary/merge-queue.

## 0.3.0 — 2026-08-02
- Keyboard shortcuts: `⌘⌥M` add comment on selection (Google Docs parity), `⌘⌥L` copy file:line ref, `⌘⌥=` / `⌘⌥-` expand/collapse all threads in file, `⌘⌥T` toggle thread at cursor.
- New commands: Expand/Collapse All Comments in File, Toggle Comment at Cursor.

## 0.2.0 — 2026-08-02
- **Comments sidebar** (Explorer view) listing every thread across the repo without opening files; open/resolved filter; Explorer count badges on files with open threads.
- **Claude Code MCP server** (`bin/mcp-comments.js`, zero-dep stdio): `list_threads`, `get_thread`, `create_thread`, `reply_to_thread`, `resolve_thread`; setup-command helper in the palette.
- **Copy file:line Reference** command (editor context menu).
- **Re-anchor to Selection** for orphaned threads.
- Richer conversation deeplinks: `claude:<sid>#<u1>..<u2>` message ranges and `claude:<sid>@<agentId>` subagent focus, with copy buttons in the graph panel.
- Robustness: sidecars follow file renames and are deleted with their file; fuzzy re-anchors write back on load; `.comments/` watcher hot-reloads external changes (git pull, MCP writes); delete-thread confirmation.
- Preview popovers linkify file/claude refs; linear conversation view gains a message filter.
- Hygiene: esbuild bundling (152 files → 11 in the VSIX), `node --test` suite (ref syntax, session parser, MCP e2e), GitHub Actions CI.

## 0.1.0 — 2026-07-31
- Anchored comment threads on any file via the VS Code Comments API, with three-tier fuzzy re-anchoring and orphan detection.
- Per-file sidecar persistence under `.comments/` (mirrored tree, committable).
- Comment-body deeplinks: `file:line[-line]` refs and `claude:<sessionId>[#<msgUuid>]` conversation chips.
- Claude conversation panel: vertical spine / horizontal timeline / linear transcript; subagent fan-outs; abandoned `parentUuid` forks collapsed by default; message peek with copy-link.
- Session vendoring into `.comments/sessions/` (including `subagents/agent-*.jsonl`).
- Commentable rendered-Markdown preview sharing the same anchored threads.
