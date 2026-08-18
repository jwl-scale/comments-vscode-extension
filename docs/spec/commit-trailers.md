# Spec: Commit trailer grammar — thread, session-segment, and provenance stamps

**Status:** draft for review
**Companions:** [sidecar-v2.md](sidecar-v2.md), [notary.md](notary.md), [session-providers.md](session-providers.md)

## Purpose

Trailers bind a commit to (a) the comment threads it addresses, (b) the agent session segment that produced its diff, and (c) a verified provenance level. Together with vendored sessions under `.comments/sessions/`, they make `git blame` resolve to reasoning: line → commit → trailer → thread + transcript segment.

Trailers are chosen over git notes or external metadata because they survive rebase and cherry-pick, travel with every clone, need no forge cooperation, and are readable with stock `git interpret-trailers` / `git log --format='%(trailers)'`.

## Trailer keys

All trailers follow git's convention: `Key: value` lines in the final paragraph of the commit message. Keys are case-sensitive as written below.

### `Comments-Thread: <threadId>`

The commit addresses this thread (implements a fix, applies a suggestion, or is the comment-commit that created/discussed it). **Repeatable** — one line per thread.

- `<threadId>` matches `th_[A-Za-z0-9-]+` (sidecar-v2 thread ids).
- "Addresses" is intentionally weaker than "resolves": a comment-commit that *opens* a thread, a partial fix, and a discussion round all address without resolving.

### `Comments-Resolves: <threadId>`

This landing resolved the thread. **Repeatable.** Implies addresses (do not also write a `Comments-Thread` line for the same id).

- Written by the notary alongside the `resolved(reason: "fixed", sha)` event it appends in the metadata commit — the two are always consistent at landing time.
- The event log remains the *authoritative* state: a thread later `reopened` does not falsify the trailer (it was true at landing), and tools reading current status MUST consult the log, not trailers. The trailer is the durable forward pointer — it makes "which commit closed this?", changelog generation, and revert detection ("the commit that resolved th_X was reverted — propose reopening") answerable from `git log` alone.

### `Agent-Session: <sessionRef>`

The session segment that produced this commit's changes. **Repeatable** (a squash commit may carry several).

`<sessionRef>` is an agent-session ref ([session-providers.md](session-providers.md)), which is the deeplink grammar used in comment bodies with the scheme retained:

```
<scheme>:<sessionId>                      whole session
<scheme>:<sessionId>#<uuid1>..<uuid2>     message segment (inclusive) — the normative form
<scheme>:<sessionId>#<uuid>               single message
<scheme>:<sessionId>@<agentId>            a subagent's transcript
```

- **The scheme is written explicitly** (`claude:`, `codex:`). A ref with no scheme is read as `claude` for compatibility, but MUST NOT be written by v0.12+ tooling.
- **The segment form is normative for commits.** A whole-session ref is permitted only when the entire session produced exactly this commit. Segments are what make session *reuse* and *forking* compatible with per-commit provenance: consecutive commits from one long-lived session carry disjoint segments of it.
- Work executed by a dispatched subagent SHOULD be stamped as `<scheme>:<sessionId>@<agentId>`, with the orchestrating main session optionally stamped as a second `Agent-Session` line (its segment covering the dispatch). The subagent ref is the per-line provenance; the main-session ref is the orchestration record.
- A commit carrying `Agent-Session` MUST have the referenced session vendored at `.comments/sessions/<sessionId>.jsonl` (and `…/subagents/agent-<agentId>.jsonl` for agent refs) in the same commit or an ancestor — normally the notary's metadata commit (see [notary.md](notary.md)). A trailer whose session is not vendored is *dangling*; tools warn but do not fail.
- A commit MAY carry refs from more than one provider (a Claude orchestrator dispatching a Codex worker, or the reverse). Provenance is computed over the union of their ops.

### `Claude-Session: <sessionRef>` *(legacy, read-only)*

The pre-v0.12 spelling of `Agent-Session`, whose value never carried a scheme.

- Readers MUST accept it and treat it as `Agent-Session: claude:<sessionRef>`.
- Writers MUST NOT emit it. It is retained because it is stamped into published history and `git blame` must keep resolving.
- A commit carrying both keys is malformed; readers take the union and warn.

### `Provenance: agent | hybrid | human`

At most one per commit. Absent ⇒ `human`.

| Value | Meaning | Who may stamp it |
|---|---|---|
| `agent` | **Verified**: the commit's entire diff is reproduced by replaying the file-mutation tool calls of the stamped session segment(s) against the parent tree (verification procedure in [notary.md](notary.md)). | Notary only. |
| `hybrid` | Session segment(s) attached, but the diff contains changes the replay does not account for (human edits in the worktree, side-effecting shell commands, other tools). | Notary, or self-declared by tooling that lands without the notary. |
| `human` | No session attached. Rationale, if recorded, lives in the threads the commit addresses. | Default. |

Rules:

- `Provenance: agent` without an `Agent-Session` trailer (or its legacy `Claude-Session` spelling) is invalid.
- Only the notary writes `agent` — it is a verification result, not a claim. Any other writer asserting agent-level provenance must use `hybrid`.
- `hybrid` is a lineage-resolution level, not a demerit. Tools MUST NOT present it as a failure state.

### `Comments-Meta-For: <commitSha>`

Marks a **metadata commit**: a commit touching only `.comments/` that carries the vendored sessions, commit brief, thread resolution events, and prunes for the code commit `<commitSha>` (its immediate parent). Written by the notary. Exactly one per metadata commit; never combined with `Agent-Session`/`Provenance` (the metadata commit has no code diff to attribute).

## Examples

Agent fix landed by the notary (commit 1 of the pair):

```
Add jitter to pipeline retry backoff

Addresses review thread on unbounded thundering-herd retries.

Comments-Resolves: th_8f2a1c…
Agent-Session: claude:9c41d0…#a3f9..b217
Provenance: agent
```

Its metadata commit (commit 2 of the pair):

```
comments: metadata for 4e5f6a7

Comments-Meta-For: 4e5f6a7
```

Human comment-commit opening a review round (touches only `.comments/`):

```
review: retry loop concerns

Comments-Thread: th_8f2a1c…
Comments-Thread: th_77b0e3…
```

Squash-merge of an implement → review → address chain (trailers accumulate; blame disambiguates through thread anchors):

```
Retry backoff with jitter (#142)

Comments-Thread: th_8f2a1c…
Agent-Session: claude:9c41d0…#0001..a3f8
Agent-Session: claude:9c41d0…#a3f9..b217
Provenance: agent
```

## Parsing and validation

- Extract with `git interpret-trailers --parse` semantics (final-paragraph block; a blank line separates it from the body).
- Value grammars:
  - thread id (`Comments-Thread`, `Comments-Resolves`): `^th_[A-Za-z0-9-]+$`
  - session ref: `^([a-z][a-z0-9-]{0,15}:)?[A-Za-z0-9_-]+(#[A-Za-z0-9_-]+(\.\.[A-Za-z0-9_-]+)?|@[A-Za-z0-9_-]+)?$` — the scheme is optional when parsing (absent ⇒ `claude`) and mandatory when writing
  - provenance: `^(agent|hybrid|human)$`
- Unknown `Comments-*` keys: ignore (forward compatibility). Malformed values of known keys: tools warn and treat the line as absent.
- Duplicate `Provenance` lines: the last one wins, with a warning.

## Blame resolution (the consumer contract)

Given a line in the working tree:

1. `git blame` → commit sha.
2. Read trailers. `Agent-Session` segment + vendored JSONL → open the transcript focused on the segment, via the ref's provider ([session-providers.md](session-providers.md)). `Comments-Thread` → thread event logs (live file, or `git show` if pruned).
3. If the blamed commit is a squash carrying multiple threads/segments, intersect the line's position with each thread's anchor (positions exact at that commit) to pick the relevant one.
4. For *history* (all conversations ever on the line), walk `git log -L` ancestry and repeat — see sidecar-v2 "Pruning and history queries."
