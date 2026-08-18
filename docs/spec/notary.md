# Spec: The notary — merge queue, provenance verification, and landing-time duties

**Status:** v1 implemented (`bin/comments-queue.js`; e2e suite in `tests/queue.test.js`). Documented v1 deviations: single-commit candidates only; no automatic rollback of the code commit when the metadata commit fails (loud warning instead — `reset --hard` under a possibly-dirty user tree is the greater evil); daemon/queue-watching mode not yet built (ad-hoc `land` invocations serialize via the lock ref).
**Companions:** [sidecar-v2.md](sidecar-v2.md), [commit-trailers.md](commit-trailers.md)

## Role

The notary is the single serialized integration point for a branch. Everything upstream of it is optimistic and concurrent (agents fixing threads in isolated worktrees, humans editing, reviewers filing threads); the notary alone lands changes, and in exchange guarantees the invariants everything else relies on:

1. Landed commits carry correct trailers (threads, session segments, verified provenance).
2. Referenced sessions are vendored; a commit brief exists for every landing.
3. Thread state advances atomically with the code (resolutions recorded, claims released).
4. All open thread anchors are re-baselined against the new HEAD — comments never silently drift because someone else's change landed.
5. The blocking gate holds: nothing lands over an open blocking thread on files it touches.

It ships as a CLI (working name: `bin/comments-queue.js`, sibling of `bin/mcp-comments.js`), runnable ad hoc (`land <branch>`), as a daemon watching a queue directory, or inside CI. One instance per target branch (enforced by a lock ref `refs/comments/queue-lock`); this serialization is the design, not a limitation — see "Concurrency model."

## Concurrency model (context)

- **Find phase** — review agents and humans create threads concurrently. No coordination: event-log appends are merge-safe (sidecar-v2).
- **Fix phase** — each fixer (agent or human) takes an advisory `claimed` lease on its thread(s) and works in an isolated git worktree branched from a pinned base. Many fixers run simultaneously. The intended policy is **at most one active fixer per thread**; a fleet wanting multiple perspectives on one thread runs them as reviewers in the find phase or attaches competing `suggested` patches, not as competing fixers. Within a single orchestrator's fleet the claim is written once at dispatch and is otherwise inert — subagent liveness is the orchestrator's own in-band monitoring (pings, task notifications), never lease renewal in the sidecar (see sidecar-v2 on claims-are-not-heartbeats). The lease's job is dedup across fleets and uncoordinated actors that share only the repo; its TTL is the crash-recovery bound when a whole fleet dies. Worktree isolation applies to **code only**: fixers read and write threads in the machine's shared live store (sidecar-v2 "Store model"), so claims, replies, and progress are visible to every actor immediately, and candidate branches carry no `.comments/` changes — thread events enter *history* via the notary's metadata commit.
- **Land phase** — fixers submit candidates to the notary. Landings are serialized; cost is proportional to integration, not to fix duration.

A **candidate** is: a branch/worktree ref, the thread ids it addresses, an optional session ref for the work, and optionally a `suggestionId` (when the candidate materializes an accepted suggestion from a thread).

## The landing pipeline

For each candidate, in order. Any failed step rejects the candidate back to its submitter (with the failure attached as a `replied` event on the thread, actor kind `notary`) — the queue moves on.

### 1. Rebase

Rebase the candidate onto current target HEAD. Conflicts are not resolved by the notary: reject, releasing nothing (the fixer keeps its claim and retries).

### 2. Gate (`check`)

Run the blocking gate against the rebased diff (see "The `check` command"). A candidate may not land while a *different* open blocking thread anchors to files it touches — except threads listed in the candidate's own address list.

### 3. Verify

Run the configured checks (tests, typecheck, lint — from `.comments/queue.json`, default `npm test`-equivalent detected per repo). Failure → reject with logs.

### 4. Provenance verification

Determines the `Provenance` trailer value. Never trust a submitted claim; compute it:

1. If no session ref: `human`. Done.
2. Extract the segment's file-mutation tool calls from the vendored session JSONL: `Edit`, `Write`, `NotebookEdit` (path, old/new content or full content), in transcript order, including those of subagents dispatched within the segment.
3. Replay them against the candidate's parent tree in a scratch index.
4. Compare the replayed tree hash to the candidate's committed tree hash (for the touched paths).
   - **Equal → `agent`.** Every byte of the diff is explained by the transcript.
   - **Not equal → `hybrid`.** The unexplained hunks are computed (`git diff <replayed> <committed>`) and recorded in the commit brief, so "which lines lack a reasoning trace" stays answerable.
5. Side-effecting `Bash` tool calls in the segment do not disqualify `agent` — the tree comparison is the arbiter. If a Bash command produced file changes, the replay won't reproduce them and the result is honestly `hybrid`.

`hybrid` is recorded matter-of-factly. The notary MUST NOT reject a candidate for being hybrid; policy about provenance levels belongs to the gate configuration, not the verifier.

### 5. Stamp and land the code commit

Amend the candidate's commit message with trailers per [commit-trailers.md](commit-trailers.md): `Comments-Resolves` for threads this landing resolves, `Comments-Thread` for threads it merely addresses, `Agent-Session` (scheme-qualified segment refs; subagent refs where applicable), `Provenance` (from step 4). Fast-forward the target branch to it. Multi-commit candidates keep their commits (unsquashed is the native form); each commit gets the trailers for the threads/segments it specifically addresses, supplied in the candidate manifest.

### 6. Metadata commit

Immediately land a second commit touching only `.comments/`, trailer `Comments-Meta-For: <code commit sha>`, containing:

- **Vendored sessions** — the referenced session JSONL (+ subagent files) copied from `~/.claude/projects` if not already vendored.
- **Commit brief** — `.comments/briefs/<code sha>.md`: a compact distillation of the segment (decisions made, alternatives rejected, invariants discovered, unexplained-hunk report for hybrids). Generated by a summarizer agent when available; falls back to a mechanical digest (files touched, tool-call inventory, thread bodies addressed). Briefs are the cheap retrieval tier; the vendored transcript is the deep tier.
- **Thread events** — appended to each addressed thread's log in the live store (visible to all actors the instant they are written; this commit is what replicates them into history):
  - `resolved(reason: "fixed", sha: <code sha>)` when the candidate carried a fix and checks passed. Auto-resolve applies only to `fixed`; a candidate may instead request a *proposed* resolution (a `replied` suggestion to resolve), per the earlier policy that agents propose `stale`/`obsolete` rather than silently closing.
  - `suggestion_accepted` when landing a suggestion.
  - `released` for the candidate's claims.
- **Re-anchor sweep** — for every open thread whose file the code commit touched: translate its anchor across the landed diff and append `reanchored(method: "diff")` with the new commit baseline. If the anchored range itself was modified by the landing, do not guess: append a `replied` event (actor `notary`) flagging the collision — "this landing rewrote your anchored text" — and leave the anchor at its old baseline for the owner (or a `re_anchor_thread`-wielding agent) to re-pin.
- **Prunes** — delete thread files resolved before this landing (configurable retention, default: prune on next landing after resolution).

The code commit and metadata commit land as an atomic pair: if step 6 fails, the target ref is rolled back to before step 5.

### 7. Notify

Emit a machine-readable landing report (JSON to stdout / queue log): shas, provenance, threads resolved, threads re-anchored, threads flagged. The extension surfaces these as toasts/sidebar updates; the async memory pipeline (Phase 4) consumes the same stream as its event source.

## The `check` command (CI gate)

`comments-queue check --base <ref> --head <ref> [--allow th_… …]`

Fails (non-zero, with a findings list) iff any thread is: open ∧ `severity: blocking` ∧ anchored to a file in `git diff --name-only base..head` ∧ not in `--allow`. Scoping to touched files is deliberate: a blocking thread on an unrelated subsystem must not freeze unrelated work.

Intended mounts: CI status on PRs, pre-land gate inside the pipeline (step 2), optional local pre-push hook. Policy variations (e.g. "hybrid commits require one human approval") are expressed here, in configuration — never hardcoded in the verifier or the extension.

## Failure and recovery

- The notary is stateless between landings; all durable state is git (target ref, lock ref, sidecars). Crash mid-pipeline: the lock ref carries the in-flight candidate; on restart, roll back to the pre-landing target sha recorded in the lock and re-run.
- Claims are leases with TTL, so a crashed fixer's threads become claimable again without intervention.
- Rejected candidates lose nothing: the worktree, the thread claim, and the rejection reason (as a thread reply) all persist.

## Explicit non-goals

- Resolving merge conflicts (rejected back to the fixer, who has the context).
- Judging code quality beyond the configured checks (that's what review threads are for).
- Enforcing a human/agent division of labor. The notary measures provenance; it never mandates it.
