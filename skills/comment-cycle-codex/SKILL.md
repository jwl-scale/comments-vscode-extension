---
name: comment-cycle-codex
description: Run review→implement→arbitrate→land cycles using anchored comment threads (Comments), with verified per-commit provenance. Use when a mission asks you to implement or fix code through the comment-thread workflow, dispatch reviewer/implementer agents, or land changes through the comments merge queue.
---

# The comment-cycle playbook (Codex)

You are the orchestrator. This repo uses **Comments**: anchored comment threads persisted as append-only event logs under `.comments/threads/`, a comments MCP server for thread operations, and a merge-queue CLI (the "notary") that lands commits with verified provenance. **You decide the composition** — how many reviewers, whether to interleave fixing with reviewing, when to iterate vs land. This file gives you the building blocks, the invariants you can rely on, and advisory recipes.

Humans and other agents (including Claude Code sessions) read and write the *same* threads. Provenance and refs are scheme-qualified (`codex:<sid>`, `claude:<sid>`), so a thread can carry a Codex fix and a Claude review without ambiguity.

## Non-negotiable duties

1. **Register your provenance AND your presence.** At session start, discover your own session id — it is the trailing UUID of your rollout file:
   `ls -t "${CODEX_HOME:-$HOME/.codex}"/sessions/*/*/*/rollout-*.jsonl | head -1` → the id is the last 36 characters before `.jsonl`.
   Then (a) call the `register_session` MCP tool (`sessionId: "codex:<sid>"`, `role: "main"`, one-line mission) so humans can watch your run live in the editor's Agent Sessions view — re-register with a `status` update at each phase change; and (b) pass the id as `--session codex:<sid>` to every `land`. The notary replays the patches your transcript records as *actually applied* against the base tree — if the diff is fully explained, the commit is stamped `Provenance: agent` with an `Agent-Session: codex:<sid>#<from>..<to>` trailer. Never claim provenance; the notary verifies it.
2. **Make file changes with `apply_patch`, not shell edits.** The provenance replayer reads the patches Codex records at apply time; changes made with `sed`, `python`, heredocs, or `>` redirection leave no record and your landing verifies `hybrid` instead of `agent`. This is not a lint — it is the difference between an attributable commit and an unattributable one.
3. **Never push to any remote.** Work only on the branch named in your mission.
4. **Don't delete threads or edit others' comments.** Resolution and history are the record.
5. **Autonomy level comes from your mission**: `autonomy: land` means you may land on the mission branch; `autonomy: suggest` means stop at suggestions and leave landing to a human.
6. **No landing without a sighted review.** Before any `land`, at least one reviewer other than you must have responded to the thread *with access to the actual change* — pass the candidate's unified diff to the reviewer (via `dispatch_agent`'s `diff` argument, or in the prompt of a `codex exec` worker). A review of intentions is not a review; an APPROVE from an agent that couldn't see the diff is void.
7. **Land at thread granularity.** One thread per landing by default — that's what makes blame, briefs, and re-anchoring precise. Batch multiple threads into one commit ONLY when the changes are genuinely inseparable (would not compile or make sense apart), and say why in a reply on each batched thread before landing.

## Building blocks

**Comments MCP tools** (server `comments`): `list_threads`, `get_thread`, `create_thread` (anchorText or 1-based lines; `severity: blocking` gates merges of that file), `reply_to_thread`, `resolve_thread` (reason: fixed|stale|wontfix|obsolete), `claim_thread`/`release_thread` (advisory lease — at most one active fixer per thread), `attach_suggestion` (unified diff for human/arbiter review), `re_anchor_thread`, `register_session`, and the memory pair: **`get_commit_context`** (sha → trailers, brief, thread discussions — use with `git blame` before modifying code you didn't write) and **`search_reasoning`** (phrase → matching briefs/threads/transcripts).

Register the server if your mission did not: `codex mcp add comments -- node <repo>/bin/mcp-comments.js`, or per-invocation with `-c mcp_servers.comments.command="node" -c 'mcp_servers.comments.args=["<repo>/bin/mcp-comments.js"]'`.

**Notary CLI** (`comments-queue`, path given in your mission):
- `check --base <ref> --head <ref> [--allow th_a,th_b]` — fail if open blocking threads anchor to touched files.
- `land --branch <sha|ref> --threads th_a[,…] --session codex:<sid> [--target <branch>] [--no-prune] [--keep-conflicts]` — the only way changes reach the target: rebase (isolated worktree) → gate → configured checks (`.comments/queue.json`) → provenance replay → trailer stamp → ff-merge → metadata commit (brief, vendored transcripts, resolved/released events, re-anchor sweep). Single-commit candidates only. Atomic; serialized by a lock.
  `--session` accepts a comma-separated list, so a commit produced by you *and* a dispatched worker can cite both sessions and still verify `agent`.
- `land-suggestion --thread th_x` — package a thread's open suggestion into a candidate and land it.

**Ways to get work done** (pick per task; mixing is fine):
- **Do it yourself**: edit in a worktree (`git worktree add`), commit once, `land`. Your session covers provenance.
- **`dispatch_agent`** (MCP): configured suggest-only workers with their own sessions — good for reviewers and second opinions; observe via thread events. Note: this tool currently spawns Claude Code workers, whose sessions land as `claude:` refs. That is fine and often desirable — a second model is a better reviewer than a second instance of yourself — but it means the dispatching is cross-provider, not Codex-to-Codex.
- **Spawn `codex exec` processes yourself**: full control and true parallelism. `codex exec --json --sandbox workspace-write -C <worktree> "<prompt>"` prints its session id on the event stream; capture it so you can cite the worker's session at landing. Read progress from the `--json` stream or from thread events.

## Invariants you can rely on

- `land` cannot be talked out of its gate, checks, or verification — land freely once your own targeted tests pass; the queue re-validates everything on the exact tree that will become HEAD.
- Rebase conflicts NEVER auto-resolve. Default: the candidate is rejected; re-derive the fix against the new head (usually cheaper than patching the patch). With `--keep-conflicts` the conflicted worktree is preserved and reported so you can resolve it deliberately, `rebase --continue`, and land the resulting sha.
- Landed siblings never roll back because a later candidate fails. Fix forward.
- Thread events are your coordination bus: claims (⏳), replies, suggestions, resolutions appear live to every observer, including the human's editor and any Claude sessions on the same repo.
- A failed `apply_patch` contributes nothing to provenance — the replayer skips it, exactly as the filesystem did.

## Advisory recipes (compose freely)

- **Verify first**: before implementing an issue, reproduce/confirm it exists at HEAD. If it doesn't, say so and stop.
- **Blame before you change**: for code you didn't write, `git blame` the lines and feed the sha to `get_commit_context` — if a prior landing produced them, you get the thread discussion, brief, and session behind the design before you undo someone's deliberate decision.
- **Review sweep**: file threads on the code you're about to change (or dispatch reviewer agents with distinct lenses — correctness, API-consistency, tests). One concern per thread; `blocking` only for must-fix. Threads anchored to exact text.
- **Fix wave**: at most one active fixer per thread (claims enforce this). Parallelize across threads, never within one.
- **Arbiter loop**: for each suggestion, evaluate against the thread's ask: reject with *specific* revision feedback (`reply_to_thread` + reject) or accept. Bounded rounds — if a thread isn't converging after ~2 revisions, do it yourself or escalate to the human in a reply.
- **Landing etiquette**: tighten `.comments/queue.json` checks to targeted tests for the packages you touch (fast landings), run those tests in your worktree before submitting, land approved work promptly rather than batching — the re-anchor sweep keeps everyone else's threads pinned.
- **Wrap-up**: `check --base <mission-start-sha> --head HEAD` must pass; every thread resolved or explicitly left open with a reason; summarize landings (shas + threads) in your final report.
