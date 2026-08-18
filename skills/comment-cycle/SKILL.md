---
name: comment-cycle
description: Run review→implement→arbitrate→land cycles using anchored comment threads (Comments), with verified per-commit provenance. Use when a mission asks you to implement or fix code through the comment-thread workflow, dispatch reviewer/implementer agents, or land changes through the comments merge queue.
---

# The comment-cycle playbook

You are the orchestrator. This repo uses **Comments**: anchored comment threads persisted as append-only event logs under `.comments/threads/`, a comments MCP server for thread operations, and a merge-queue CLI (the "notary") that lands commits with verified provenance. **You decide the composition** — how many reviewers, whether to interleave fixing with reviewing, when to iterate vs land. This file gives you the building blocks, the invariants you can rely on, and advisory recipes.

## Non-negotiable duties

1. **Register your provenance AND your presence.** At session start, discover your own session id:
   `ls -t ~/.claude/projects/$(pwd | sed 's|[/.]|-|g')/*.jsonl | head -1` (basename minus `.jsonl`).
   Then (a) call the `register_session` MCP tool (`role: "main"`, one-line mission) so humans can watch your run live in the editor's Agent Sessions view — re-register with a `status` update at each phase change; and (b) pass the id as `--session claude:<sid>` to every `land`. The notary replays your transcript's Edit/Write calls (including Task-subagent transcripts and worktree paths) against the base tree — if the diff is fully explained, the commit is stamped `Provenance: agent` with an `Agent-Session: claude:<sid>#<from>..<to>` trailer. Never claim provenance; the notary verifies it.
2. **Make file changes through the Edit/Write/MultiEdit tools, not shell scripts.** The provenance replayer traces tool calls; edits made via `sed`/`python`/heredocs are invisible to it and your landing verifies `hybrid` instead of `agent`.
3. **Never push to any remote.** Work only on the branch named in your mission.
4. **Don't delete threads or edit others' comments.** Resolution and history are the record.
5. **Autonomy level comes from your mission**: `autonomy: land` means you may land on the mission branch; `autonomy: suggest` means stop at suggestions and leave landing to a human.
6. **No landing without a sighted review.** Before any `land`, at least one reviewer other than you must have responded to the thread *with access to the actual change* — pass the candidate's unified diff via `dispatch_agent`'s `diff` argument (or give a subagent the worktree path). A review of intentions is not a review; an APPROVE from an agent that couldn't see the diff is void.
7. **Land at thread granularity.** One thread per landing by default — that's what makes blame, briefs, and re-anchoring precise. Batch multiple threads into one commit ONLY when the changes are genuinely inseparable (would not compile or make sense apart), and say why in a reply on each batched thread before landing.

## Building blocks

**Comments MCP tools** (server `comments`): `list_threads`, `get_thread`, `create_thread` (anchorText or 1-based lines; `severity: blocking` gates merges of that file), `reply_to_thread`, `resolve_thread` (reason: fixed|stale|wontfix|obsolete), `claim_thread`/`release_thread` (advisory lease — at most one active fixer per thread), `attach_suggestion` (unified diff for human/arbiter review), `re_anchor_thread`, **`dispatch_agent`** (spawn a configured worker on a thread: model, effort, permissionMode, system prompt, tools, sessionMode fresh/continue — returns its sessionId immediately; watch progress via `get_thread`), and the memory pair: **`get_commit_context`** (sha → trailers, brief, thread discussions — use with `git blame` before modifying code you didn't write) and **`search_reasoning`** (phrase → matching briefs/threads/transcripts).

**Notary CLI** (`comments-queue`, path given in your mission):
- `check --base <ref> --head <ref> [--allow th_a,th_b]` — fail if open blocking threads anchor to touched files.
- `land --branch <sha|ref> --threads th_a[,…] --session <sid> [--target <branch>] [--no-prune] [--keep-conflicts]` — the only way changes reach the target: rebase (isolated worktree) → gate → configured checks (`.comments/queue.json`) → provenance replay → trailer stamp → ff-merge → metadata commit (brief, vendored transcripts, resolved/released events, re-anchor sweep). Single-commit candidates only. Atomic; serialized by a lock.
- `land-suggestion --thread th_x` — package a thread's open suggestion into a candidate and land it.
- `fleet --threads … --claude <cmd>` — headless convenience: one fixer process per thread in isolated worktrees, landed serially. You usually don't need it — you can orchestrate better yourself.

**Ways to get work done** (pick per task; mixing is fine):
- **Do it yourself**: edit in a worktree (`git worktree add`), commit once, `land`. Your session covers provenance.
- **Task subagents**: cheap, share your context, cannot nest. Their edits count toward YOUR session's provenance (transcripts are merged in replay).
- **`dispatch_agent`** (MCP): configured suggest-only workers with their own sessions — good for reviewers and second opinions; observe via thread events.
- **Spawn `claude -p` processes yourself**: full control (any flags), own sessions, true parallelism; monitor by tailing `~/.claude/projects/<slug>/<sid>.jsonl` or via thread events.

## Invariants you can rely on

- `land` cannot be talked out of its gate, checks, or verification — land freely once your own targeted tests pass; the queue re-validates everything on the exact tree that will become HEAD.
- Rebase conflicts NEVER auto-resolve. Default: the candidate is rejected; re-derive the fix against the new head (usually cheaper than patching the patch). With `--keep-conflicts` the conflicted worktree is preserved and reported so you can resolve it deliberately, `rebase --continue`, and land the resulting sha.
- Landed siblings never roll back because a later candidate fails. Fix forward.
- Thread events are your coordination bus: claims (⏳), replies, suggestions, resolutions appear live to every observer, including the human's editor.

## Advisory recipes (compose freely)

- **Verify first**: before implementing an issue, reproduce/confirm it exists at HEAD. If it doesn't, say so and stop.
- **Blame before you change**: for code you didn't write, `git blame` the lines and feed the sha to `get_commit_context` — if a prior landing produced them, you get the thread discussion, brief, and session behind the design before you undo someone's deliberate decision.
- **Parallel recon**: your opening context-gathering is embarrassingly parallel — fan out subagents at the start (one per subsystem/question: the buggy module, its tests, its callers, repo conventions) rather than reading serially. Cheap, fast, and keeps your own context lean.
- **Review sweep**: file threads on the code you're about to change (or dispatch reviewer agents with distinct lenses — correctness, API-consistency, tests). One concern per thread; `blocking` only for must-fix. Threads anchored to exact text.
- **Fix wave**: at most one active fixer per thread (claims enforce this). Parallelize across threads, never within one.
- **Arbiter loop**: for each suggestion, evaluate against the thread's ask: reject with *specific* revision feedback (`reply_to_thread` + reject) or accept. Bounded rounds — if a thread isn't converging after ~2 revisions, do it yourself or escalate to the human in a reply.
- **Landing etiquette**: tighten `.comments/queue.json` checks to targeted tests for the packages you touch (fast landings), run those tests in your worktree before submitting, land approved work promptly rather than batching — the re-anchor sweep keeps everyone else's threads pinned.
- **Wrap-up**: `check --base <mission-start-sha> --head HEAD` must pass; every thread resolved or explicitly left open with a reason; summarize landings (shas + threads) in your final report.
