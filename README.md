# Comments — anchored threads for code & agents

Highlight text in **any file**, leave an anchored comment thread, and share it with your team by committing the `.comments/` directory. Threads survive edits, refactors, and rebases; they deeplink into files (`src/foo.ts:12-34`) and into your coding agent's conversations (`claude:<sessionId>#<msgUuid>`, `codex:<sessionId>#<id>`) rendered as an interactive graph.

Humans and agents use the same threads. A bundled MCP server lets **Claude Code** and **Codex** read, answer, and resolve comments; a merge queue lands agent-authored commits with **verified provenance** — the diff is replayed against the agent's own transcript, so `Provenance: agent` is a check, not a claim.

## Install

Install **Comments** from the VS Code Marketplace or Open VSX, or from the command line:

```bash
code --install-extension jonathan-lee.anchored-comments
```

Cursor, Windsurf, and other VS Code forks: install from Open VSX, or `cursor --install-extension jonathan-lee.anchored-comments`.

Then, to wire up the agent loop:

1. **Comments: Copy MCP Setup Command** → paste it in a terminal in your project.
2. **Comments: Install Agent Skill (comment-cycle)** → installs the orchestration playbook for Claude Code (workspace) or Codex (`$CODEX_HOME/skills/`).

Neither is required to use comments by hand.

## Features

### Anchored comment threads (any file)
- Select text → `⌘⌥M` (or right-click → **Comments: Add Comment on Selection**, or click the `+` in the gutter).
- Threads support replies, edit, delete (with confirmation), resolve/unresolve.
- Anchors are **fuzzy and best-effort**: threads survive edits, moved text, and small rewrites. When the anchored text disappears entirely, the thread is marked `⚠ orphaned` instead of being lost — select the new home text and click 📌 **Re-anchor to Selection** to re-pin it.
- Commented ranges get a subtle highlight + overview-ruler mark.
- `⌘⌥=` / `⌘⌥-` expand/collapse every thread in the file; `⌘⌥T` toggles the thread under the cursor.

### Rich deeplinks in comment bodies
Typed or pasted refs auto-render as clickable links:

| Ref | Opens |
|---|---|
| `file.ts:12` · `src/foo.ts:12-34` · `mcpx-go/Dockerfile:1-2` | the file, selected at that range |
| `thread:<threadId>` | that comment thread, revealed and expanded in its file |
| `thread:<threadId>#<commentId>` | same, recording which comment was meant |
| `claude:<sessionId>` | the whole conversation |
| `claude:<sessionId>#<msgUuid>` | the conversation, focused on one message |
| `claude:<sessionId>#<uuid1>..<uuid2>` | focused on a message range |
| `claude:<sessionId>@<agentId>` | focused on a subagent |

File refs need a dot-extension, a directory separator, or a well-known extensionless name (`Dockerfile`, `Makefile`, `LICENSE`, …) — `12:30` and `error TS2345:` stay plain text. `⌘⌥L` copies a `file:line` ref for the current selection; every comment has a 🔗 **Copy Reference** button (`thread:<id>#<commentId>`), **Copy Thread Reference** lives in the thread's overflow menu, and copy buttons for session/message refs live in the Sessions… menu and conversation panel. Threads can therefore cross-reference each other — a thread chip renders with the target's file and first-comment snippet.

### Conversation graph
Opens in a side panel with three views (toolbar toggles; defaults in settings):
- **Vertical spine** — main agent top-to-bottom, subagents fan out right with bezier edges (in the style of [claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) + the subagent-graph fork).
- **Horizontal timeline** — same graph, transposed.
- **Linear transcript** — scrolling message list with inline collapsible subagent transcripts and a text filter box.

Abandoned forks (message edits / retries, detected from the `parentUuid` tree) render **collapsed by default** as `⑂ N abandoned messages` stubs — click to expand. Sessions that restarted their chain (continuation/compaction) render as sequential spine segments. Click any node for a peek card with the full message, tool calls, and copy-link / show-in-transcript actions. Deeplinked messages get a focus ring and auto-scroll; ranges tint every message in the span; agent links auto-open that agent's transcript.

### Portability
- Comments persist as per-thread event logs: `<repo>/.comments/threads/<threadId>.jsonl` (append-only, merge-safe — see [Storage format](#storage-format-v2)).
- **Attach Claude Session…** (thread toolbar ✳ button) picks a session from `~/.claude/projects` and *vendors it* into `.comments/sessions/<id>.jsonl` (+ `<id>/subagents/agent-*.jsonl`), so anyone who clones the repo can open the conversation. Clicking a hand-typed `claude:` ref vendors on demand when the session exists locally.

### Commentable Markdown preview
**Comments: Open Markdown Preview (commentable)** (editor title button on `.md` files):
- Existing threads render as highlights in the rendered preview.
- Select rendered text → **💬 Comment** — the selection maps back to source lines and creates the *same* anchored thread you'd see in the raw editor.
- Click a highlight to view/reply/resolve in place; file and `claude:` refs in the popover are clickable.

### Comments sidebar & badges
A **Comments** view in the Explorer sidebar lists every thread across the repo (read straight from `.comments/`, no need to open files), with open/resolved filtering, refresh, and click-to-jump. Files with open threads get a count badge in the Explorer.

### Assign a thread to an agent (agent loop)
Click ▶ **Assign to Agent** on any open thread: the extension takes an advisory claim, runs your agent headlessly (`claude -p` or `codex exec`, per `mdComments.agent.provider`) with the thread as context and the comments MCP server wired in, and the agent replies in the thread — investigating with read-only tools and attaching code changes as **suggestions** (unified diffs rendered inline, ✓ accept / ✗ reject in the thread toolbar; accept applies the patch to your working tree). The resulting conversation is vendored and attached as a `claude:` / `codex:` chip for provenance.

Steer the run with **mentions** in your latest comment:

| Mention | Effect |
|---|---|
| `@claude` / `@codex` | that provider's default agent |
| `@security-reviewer` (any name) | applies the agent definition from `.claude/agents/<name>.md` (repo or `~/.claude`) as the system prompt |
| `@claude:<sessionId>[#<msgUuid>]` / `@codex:<sessionId>` | forks (Claude) or resumes (Codex) that vendored session — the agent starts with the context that wrote the code |

**Sessions are sticky per thread**: after the first run, follow-up assigns *continue* the same agent session (multi-turn — the agent remembers the earlier discussion). Session mode is controllable (`auto` / `fresh` / `continue` / `fork`); `auto` forks a mentioned session, else continues the thread's session, else starts fresh. Every agent reply carries a clickable chip to its conversation.

**⚙ Assign to Agent (Configure Run…)** next to ▶ opens the run configuration: agent definition, session mode, model (full `/model`-style alias list: fable, opus, sonnet, `sonnet[1m]`, haiku, opusplan, or a custom id), reasoning effort (offered when your CLI supports `--effort` — probed automatically), permission mode (default keeps runs suggest-only), tool allowlist, system prompt (append to the default, or **replace** it entirely — agent definitions and append text still stack), max turns, and extra CLI args. Choices persist per workspace; global defaults live in the `mdComments.agent.*` settings. An **agent definition** is just a named preset of these knobs — a markdown file in `.claude/agents/` with frontmatter + a system-prompt body.

**💬 Ask Agent (Follow-up…)** collapses reply-then-assign into one gesture: type the follow-up, and if the thread already has a session, choose **continue** (same conversation, full memory) / **fork** (inherit context, branch off) / **fresh** — then it posts your reply and dispatches.

**🗂 Sessions…** on any thread lists every agent session related to it, grouped by relationship: the **current** session (what ▶ continues), sessions that **produced specific comments** (with a deep link to the exact reply moment — the extension finds the MCP call in the vendored transcript, so you land on the portion of the session behind that comment), and sessions **referenced** in comment bodies (opened with whatever `#message` / range / `@agent` focus the ref carries). Threads support any number of sessions — continuations, forks, and different agents accumulate naturally.

Threads carry **severity** (`normal` / `blocking`, ⛔ badge; toggle in the thread menu) and **claims** (⏳ badge while an agent holds the lease — at most one active fixer per thread). Point `mdComments.agent.command` at a wrapper script to customize the CLI invocation.

### MCP integration (Claude Code, Codex, any MCP client)
Run **Comments: Copy MCP Setup Command** and paste it in a terminal in your project:

```bash
claude mcp add comments -- node /path/to/extension/bin/mcp-comments.js
# or
codex mcp add comments -- node /path/to/extension/bin/mcp-comments.js
```

The bundled server (`bin/mcp-comments.js`, zero dependencies, newline-delimited JSON-RPC over stdio) exposes five tools:

| Tool | Does |
|---|---|
| `list_threads` | all threads, filterable by `file` / `status` |
| `get_thread` | one thread with full history |
| `create_thread` | new thread anchored by exact text or 1-based line range |
| `reply_to_thread` | append a reply (author defaults to `claude`) |
| `resolve_thread` | set status resolved / open, with a reason (`fixed` / `stale` / `wontfix` / `obsolete`) |
| `claim_thread` / `release_thread` | advisory lease — at most one active fixer per thread |
| `set_severity` | `normal` / `blocking` (blocking threads gate merges) |
| `attach_suggestion` | attach a unified-diff suggestion for human accept/reject |
| `re_anchor_thread` | re-pin an orphaned/drifted thread by text or line range |

The workspace root comes from `$MD_COMMENTS_ROOT` or the client's cwd. The extension watches `.comments/` and hot-reloads external writes, so agent replies appear in open editors immediately — comments work as a human↔agent task queue.

### The notary: landing pipeline & blocking gate (`bin/comments-queue.js`)

Zero-dep CLI implementing `docs/spec/notary.md` — the serialized integration point for agent (and human) fixes:

```bash
# CI gate: fail if any open BLOCKING thread anchors to a file changed in base..head
node bin/comments-queue.js check --base main --head my-branch [--allow th_a,th_b]

# Land a single-commit candidate branch
node bin/comments-queue.js land --branch fix-retry --threads th_8f2a --session <sessionId>
```

```bash
# Package a thread's open suggestion into a candidate and land it (⚙ "Accept & Land" in the editor)
node bin/comments-queue.js land-suggestion --thread th_8f2a

# Fleet: one fixer agent per thread, each in an isolated worktree, landed serially
node bin/comments-queue.js fleet --threads th_a,th_b,th_c [--claude <cmd>] [--parallel 4]
```

**Accept & Land** (🚀 on suggestion threads) builds the candidate in a scratch worktree — your working tree is never dirtied — applies the suggestion, and runs the landing pipeline; the suggesting session verifies as `Provenance: agent` because the replayer understands `attach_suggestion` calls. **Dispatch Fleet…** (palette, or `fleet` in CI) claims each selected thread, runs one fixer agent per thread in its own worktree (editing files directly under `acceptEdits`, replying via MCP into the shared live store — progress is visible in your sidebar as it happens), commits each result, and lands them serially through the queue; sibling in-flight threads are gate-exempt, and reply-only outcomes release their claim without landing.

`land` runs the full pipeline: rebase in an isolated worktree → blocking gate (your own threads exempt) → configured checks (`.comments/queue.json`: `{ "checks": ["npm test"] }`) → **provenance verification** (replays the session's Edit/Write tool calls against the base tree and compares: byte-identical → `Provenance: agent`, else `hybrid` with the unexplained files listed) → stamps commit trailers (`Comments-Resolves`, `Claude-Session: <sid>#<from>..<to>` segment, `Provenance`) → fast-forwards the target → lands a **metadata commit** (`Comments-Meta-For`) carrying the vendored session, a commit brief (`.comments/briefs/<sha>.md`), `resolved(fixed, sha)` + `released` events, a **re-anchor sweep** (open threads on touched files re-baseline to the landed sha via diff translation; collisions get a notary reply instead of a guess), and prunes of previously-resolved thread files. Landings serialize via `.git/comments-queue.lock`; the result is a JSON report. After this, `git blame` → trailer → thread + session segment: every landed line has a reasoning trace.

### Blame-indexed memory (Phase 4)

Every landed line answers "why is this here?":

- **Hover any line** whose last-touch commit carries Comments trailers: a hover chip shows the commit, its verified `Provenance`, links to the thread(s) it resolved, and the `claude:` conversation segment behind it. Lines with no recorded reasoning show nothing.
- **Comments: Line History** (editor right-click) walks the selection's ancestry with `git log -L` and joins each commit against the conversation layer *as it existed at that commit* — trailers, threads anchored to the file then (positions exact at that sha), landing briefs — with actions to open the conversation, the threads, the brief, or the diff.
- **Agent-side retrieval over MCP**: `get_commit_context(sha)` returns the trailers, brief, and thread discussions behind a blamed commit (recovering pruned threads from history); `search_reasoning(query)` greps briefs, thread discussions, and vendored transcripts. Causal retrieval — results are linked to the commits and conversations that produced the code, not similarity-matched. The comment-cycle skill instructs agents to blame-before-changing unfamiliar code.

### Robustness
- Anchors are pinned to git baselines (commit sha, or a blob for dirty captures) and translated deterministically via diff on load; fuzzy matching is a badged last resort. Persisted positions only change through explicit `reanchored` events — after a commit, threads re-baseline to the new HEAD automatically.
- Renames and deletes are recorded as thread events (`renamed`, `resolved(obsolete)`) — history is never silently erased.
- External thread-log changes (git pull, MCP writes, worktree agents) hot-reload into open editors; the live store is shared repo-wide, so agents working in isolated worktrees are visible immediately.

## Keyboard shortcuts

| | Mac | Win/Linux |
|---|---|---|
| Add comment on selection | `⌘⌥M` | `Ctrl+Alt+M` |
| Copy file:line reference | `⌘⌥L` | `Ctrl+Alt+L` |
| Expand all comments in file | `⌘⌥=` | `Ctrl+Alt+=` |
| Collapse all comments in file | `⌘⌥-` | `Ctrl+Alt+-` |
| Toggle comment at cursor | `⌘⌥T` | `Ctrl+Alt+T` |

All bound when the editor has focus; remap under the `mdComments.` prefix in Keyboard Shortcuts (`⌘K ⌘S`).

## Commands

| Command | Where |
|---|---|
| Comments: Add Comment on Selection | palette, editor right-click, `⌘⌥M` |
| Comments: Copy file:line Reference | palette, editor right-click, `⌘⌥L` |
| Comments: Expand / Collapse All Comments in File | palette, `⌘⌥=` / `⌘⌥-` |
| Comments: Toggle Comment at Cursor | palette, `⌘⌥T` |
| Comments: Open Markdown Preview (commentable) | palette, editor title on `.md` |
| Comments: Copy MCP Setup Command | palette |
| Comments: Install Agent Skill (comment-cycle) | palette (Claude Code workspace, or Codex `$CODEX_HOME`) |
| Comments: Verify MCP Setup | palette (server roundtrip + stale-registration check) |
| Comments: Migrate Sidecars to v2 (event logs) | palette (also offered on startup) |
| Comments: Open Conversation | palette (picks a vendored session, any provider) |
| Attach Session… | thread toolbar ✳, palette |
| Resolve / Unresolve / Delete Thread | thread toolbar |
| Re-anchor to Selection | thread toolbar 📌 (orphaned threads) |
| Edit / Delete (comment) | comment hover menu |
| Refresh / Toggle Resolved Threads | Comments view toolbar |

## Settings

| Setting | Default | |
|---|---|---|
| `mdComments.authorName` | OS username | Author on new comments |
| `mdComments.agent.provider` | `claude` | `claude` \| `codex` — which agent Assign-to-Agent dispatches |
| `mdComments.agent.command` | provider default | CLI for agent runs (point at a wrapper script to customize flags) |
| `mdComments.agent.model` | CLI default | Default model for agent runs |
| `mdComments.agent.permissionMode` | `default` | `default` (suggest-only) \| `acceptEdits` \| `plan` \| `bypassPermissions` |
| `mdComments.agent.allowedTools` | comments MCP set | Tool allowlist for agent runs (Claude only; Codex gates tools via its sandbox) |
| `mdComments.agent.appendSystemPrompt` | — | Appended to every run's system prompt |
| `mdComments.agent.systemPrompt` | — | Replaces the base system prompt (Codex: prepended to the prompt) |
| `mdComments.agent.effort` | CLI default | `low` \| `medium` \| `high` |
| `mdComments.agent.maxTurns` | unlimited | Turn cap per run |
| `mdComments.agent.extraArgs` | — | Extra CLI flags (effort, betas, …) |
| `mdComments.graphOrientation` | `vertical` | `vertical` \| `horizontal` |
| `mdComments.conversationView` | `graph` | `graph` \| `linear` |

## Storage format (v2)

`.comments/threads/<threadId>.jsonl` — one append-only event log per thread, plus `.comments/sessions/` for vendored conversations. Commit the whole directory. Full contract: `docs/spec/sidecar-v2.md` in this repo.

```jsonl
{"id":"ev_…","type":"created","seq":1,"ts":"2026-08-02T…","actor":{"name":"dev","kind":"human"},"version":2,"file":"src/pipeline/retry.ts","anchor":{"baseline":{"kind":"commit","sha":"9c41…"},"start":{"line":18,"char":6},"end":{"line":19,"char":17},"text":"await sleep(delay);\n      delay *= 2;","prefix":"…","suffix":"…"},"body":"No jitter — see claude:8f2a…#a3f9","commentId":"c_…","severity":"normal"}
{"id":"ev_…","type":"replied","seq":2,"ts":"…","actor":{"name":"claude","kind":"agent"},"commentId":"c_…","body":"fixed in abc123"}
{"id":"ev_…","type":"resolved","seq":3,"ts":"…","actor":{"name":"claude","kind":"agent"},"reason":"fixed"}
```

Key properties:

- **Event-sourced**: replies, edits, resolutions, re-anchors, and renames are permanent attributed events; rendered state is a fold ordered by `(seq, ts, id)`. Full lineage, no lost updates.
- **Merge-safe**: logs merge with git's union driver (the extension writes `.comments/threads/*.jsonl merge=union` to `.gitattributes`); duplicate lines dedupe by event id, fold order is content-derived. Concurrent branches never conflict.
- **Anchored to git baselines**: positions are exact at a recorded baseline — a commit sha (clean capture) or a blob written to the object store (dirty capture). Resolution is baseline diff-translation first; the fuzzy matcher (exact text scored by context → line-window similarity) is a badged last resort, and orphaning is explicit.
- **One store per repository**: all writers (extension, MCP processes, agents in linked worktrees) resolve the primary working tree's `.comments/` via the git common dir and serialize appends with a per-thread lockfile.

v1 mirrored-tree sidecars are migrated by **Comments: Migrate Sidecars to v2** (the extension offers this on startup when it finds any).

## Development

```bash
npm install
npm test                 # tier 1: tsc + node --test (format fold, diff translation, refs, sessions, MCP stdio)
npm run test:integration # tier 2: real VS Code (extension host) against a hermetic git repo
npm run test:ui          # tier 3: Playwright driving desktop VS Code (webviews + comment-widget smoke)
npm run test:all         # all three tiers
npm run bundle           # esbuild -> dist/extension.js
npm run watch            # tsc incremental for F5 debugging
```

Tiers 2–3 download VS Code into `.vscode-test/` on first run (cached) and exercise the **bundled** extension (`dist/`), i.e. the artifact that ships. Tier 2 covers the e2e contracts: thread lifecycle events, v1 migration, MCP hot-reload into open editors, diff re-baselining after commits, rename events, and the MCP doctor. Tier 3 asserts our webview DOM (conversation graph, commentable preview) plus one golden-path native smoke (select → `⌘⌥M` → type → submit → event log on disk).

`F5` in VS Code runs the extension in a dev host. Package with `npx @vscode/vsce package` (runs `bundle` via `vscode:prepublish`). CI (`.github/workflows/ci.yml`) runs tests + bundle on push/PR.

### Layout

```
src/extension.ts     activation & command wiring
src/comments.ts      CommentController: threads, decorations, event appends
src/threadLog.ts     v2 event-log format: parse, fold, locked appends (no vscode)
src/baseline.ts      git baselines + Myers-diff position translation (no vscode)
src/anchor.ts        anchor capture/resolve: exact → diff → fuzzy → orphan
src/store.ts         live store resolution, thread IO, v1 migration
src/sessions.ts      session discovery, vendoring, Claude JSONL → graph model
src/sessionProviders.ts  Codex rollout discovery + rollout → graph model (no vscode)
src/links.ts         comment-body linkification, file deeplink opener
src/refs.ts          ref grammar (file / agent-session / thread), shared with tests (no vscode)
src/graphPanel.ts    conversation webview host
src/previewPanel.ts  commentable markdown preview host (markdown-it + data-line)
src/treeView.ts      Comments sidebar + Explorer badges
media/               webview clients (graph.js/css, preview.js/css)
bin/mcp-comments.js  standalone MCP server (no deps)
bin/comments-queue.js  the notary: gate, provenance replay, landing pipeline
bin/lib/session-providers.js  locate/extract for claude + codex transcripts (no deps)
skills/              comment-cycle playbooks (Claude + Codex), shipped in the VSIX
tests/               node --test suites + fixtures
```
