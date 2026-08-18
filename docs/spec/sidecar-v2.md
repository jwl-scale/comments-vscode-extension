# Spec: Sidecar format v2 — append-only thread event logs

**Status:** draft for review · **Supersedes:** v1 per-file sidecars (`SidecarFile` in `src/model.ts`)
**Companions:** [commit-trailers.md](commit-trailers.md), [notary.md](notary.md)

## Goals

1. **Merge-safe multi-user storage.** Concurrent writers (humans, agents, MCP, other branches) must never lose data on `git merge`. v1's last-write-wins JSON documents fail this.
2. **Lineage.** Every mutation to a thread (reply, edit, resolve, re-anchor, claim) is a permanent, attributed event. Rendered state is a fold over the log.
3. **Exact anchoring.** Persisted positions are always valid at a recorded baseline (commit or blob). Drift handling happens at resolve time, in memory; sidecars never store fuzzy-drifted positions.
4. **History-queryable.** Resolved threads can be pruned from the working tree and recovered exactly from git history (`git show <sha>:.comments/threads/<id>.jsonl`).

## Directory layout

```
.comments/
  threads/<threadId>.jsonl      one event log per thread, stable path for life
  sessions/<sid>.jsonl          vendored Claude Code sessions (unchanged from v1)
  sessions/<sid>/subagents/agent-*.jsonl
  briefs/<commitSha>.md         commit briefs, written by the notary   (reserved)
  facts/                        anchored knowledge-base facts          (reserved)
  views/                        projected knowledge views              (reserved)
```

- Thread files are **flat** under `threads/` (no mirrored source tree, no per-source-file folders): n threads on one source file are n separate `.jsonl` files, each recording its target file internally. Flat-and-stable is deliberate: if thread paths encoded the source path, renaming a source file would move sidecars and break the property that `git log -- .comments/threads/<id>.jsonl` follows a thread's entire life. Renames are `renamed` events instead. The cost — "which threads target file X" requires reading the logs — is acceptable at realistic scale (thread files are small) and can later be served by a derived index cache, never a second source of truth.
- `threadId` is `th_<uuid>` (lowercase hex uuid, dashes allowed). The path never changes for the life of the thread — renames of the *source* file are recorded as events, not sidecar moves.

### Required `.gitattributes`

The extension ensures this line exists when creating the first thread:

```
.comments/threads/*.jsonl merge=union
```

Union merge is safe **iff** the format keeps its two invariants: every line is a self-contained event with a globally unique `id`, and fold order is derived from event content (`ts`, `id`), never from line order. Duplicate lines after a merge are deduplicated by `id` at read time.

## Event log format

Each thread file is newline-delimited JSON: one event object per line, UTF-8, LF. Line order is *not* significant. Writers only ever append (or delete the whole file — see Pruning).

### Common envelope

| Field | Type | Notes |
|---|---|---|
| `id` | string | `ev_<uuid>`, globally unique. Dedup key. |
| `type` | string | Event type (below). Readers MUST ignore-but-preserve unknown types. |
| `seq` | number | Lamport counter: `1 + max(seq)` over all events present in the log as the writer sees it at append time. Primary sort key. |
| `ts` | string | ISO-8601 UTC with millisecond precision. Secondary sort key; display timestamp. |
| `actor` | object | `{ "name": string, "kind": "human" \| "agent" \| "notary" }`. Agent actors SHOULD set `name` to the agent definition name (e.g. `security-reviewer`) and MAY add `session`, an agent-session ref (`[<scheme>:]<sid>[#<uuid>][@<agentId>]`, see [session-providers.md](session-providers.md); a bare ref with no scheme means `claude`). |

Fold order: sort by (`seq`, `ts`, `id`) ascending. The Lamport `seq` makes causal order robust to clock skew: a writer appending in response to visible state has, by construction, read the log, so its event sorts after everything it saw regardless of its wall clock. Genuinely concurrent events (two branches, neither saw the other) may share a `seq`; for those no ordering is "correct" and (`ts`, `id`) provides a deterministic, machine-independent tiebreak.

### Store model: one database per repository

Semantically, `.comments/` is a **database**: a single logical store per repository, visible to every human and agent immediately, regardless of which branch or worktree they are working in. Git is its **replication and archival layer** — not its live medium.

**The live store (per machine).** There is exactly one live store per repository per machine: the `.comments/` directory of the repository's **primary working tree**. Every writer — the extension host, every `mcp-comments` process (including headless runs with no VS Code open), fixer agents inside linked worktrees, the notary — resolves it via the git common dir (`git rev-parse --git-common-dir` → the primary worktree; `$MD_COMMENTS_ROOT` overrides) and writes there. `.comments/` directories inside linked worktrees hold **no live state**. Consequence, by design: a fixer resolving a thread from an isolated worktree is visible in everyone's sidebar the moment it happens. Worktree isolation applies to *code*; comments are the shared coordination channel between isolated actors, and a coordination channel must have a single view.

**Serialization (the machine's leader).** Writes to a thread are serialized by a per-thread lockfile: create-exclusive `threads/<id>.jsonl.lock` (bounded retry with backoff) → read the tail to compute `seq` → append exactly one complete event line → unlink the lock. The filesystem's lock manager is the machine's leader. It is deliberately not a daemon (and specifically not the extension process): a leader process would have to be running for headless CI writes, would need leader election across multiple VS Code windows, and would convert "any tool can write the format with plain file IO" into "the format requires a service." Under the lock, `seq` is strictly increasing per machine. Readers take no lock and MUST tolerate a torn final line (skip it) — with locked single-line appends, a torn tail can only mean a writer crashed mid-append, losing only its own event.

**Replication between machines (via git).** Other machines receive the store as commits: comment-commits and notary metadata commits snapshot the live store into history; `git pull` merges snapshots from elsewhere. That merge is the only place concurrent histories genuinely meet, and it is what the format's merge rules exist for: union merge plus the order-independent fold means two machines' snapshots always merge without conflicts or data loss. `seq` values may tie across machines; (`ts`, `id`) breaks ties deterministically.

**Networked single-writer deployments (optional).** A deployment MAY replace git-replication with a service that owns the store and serializes all submissions over the network. That is the only configuration in which an OCC precondition (expected thread-state hash) is meaningful, as a staleness guard; implementations without one MUST NOT require the field. The on-disk and wire format is identical in every configuration — only the serializing authority differs: kernel lock manager (one machine) → git merge (across machines, asynchronous) → service (networked, live).

### Event types

**`created`** — first line of every log.
`file` (workspace-relative posix path), `anchor` (see Anchors), `body` (markdown, first comment), `commentId` (`c_<uuid>`), `severity` (optional, default `"normal"`).

**`replied`** — `commentId` (new `c_<uuid>`), `body`.

**`edited`** — `commentId` (of an existing comment), `body` (the new full body). Prior bodies remain in earlier events: the version history of a comment is the `created`/`replied` event plus its chain of `edited` events. Renderers show the latest body with an "edited" affordance exposing history.

**`comment_deleted`** — `commentId`. Tombstone: renderers hide the comment; the log retains it for lineage. (True redaction requires history rewrite and is explicitly out of scope.)

**`resolved`** — `reason`: `"fixed" | "stale" | "wontfix" | "obsolete"`; `sha` (optional, the commit that resolves it — the notary always sets this for `fixed`); `note` (optional markdown).

**`reopened`** — no extra fields.

**`severity_changed`** — `severity`: `"normal" | "blocking"`.

**`reanchored`** — `anchor` (complete new anchor incl. new baseline), `method`: `"manual" | "delta" | "diff" | "fuzzy"`. Written on re-baseline at commit time, by the notary's re-anchor sweep, or by manual re-pin. `fuzzy` re-anchors MUST be badged in UIs.

**`renamed`** — `file` (new path). Follows source-file renames.

**`claimed`** — `ttlSeconds` (number). Advisory lease: the actor intends to address this thread. A live claim is the latest `claimed` (by fold order) with no later `released` by the same actor and `now < ts + ttlSeconds`. Clocks are untrusted; claims prevent duplicate work, not correctness violations.

Claims are **coarse and cross-fleet**: one `claimed` per fix attempt with a generous TTL (default 3600s), `released` (or a landing) when done. They coordinate actors that share no orchestrator — two developers' machines, a human picking up a thread in the extension, an async assign-to-Claude run. They are the intended policy's unit of "at most one active fixer per thread." Claims MUST NOT be used as heartbeats: these logs are committed files, and high-frequency lease renewal would be pure git churn. Liveness of dispatched subagents is their orchestrator's in-band concern (direct pings/monitoring); the TTL exists only as the crash-recovery bound for when an entire fleet dies without releasing.

**`released`** — ends the actor's claim early.

**`suggested`** — `patch` (unified diff, may span files), `baseline` (baseline object the patch applies to), `suggestionId` (`s_<uuid>`). A patch-carrying proposal ("suggestion mode"); produced by agents or humans.

**`suggestion_accepted`** / **`suggestion_rejected`** — `suggestionId`. Acceptance is recorded here; the actual application + landing is the notary's job and produces the `resolved(fixed, sha)` event.

### Fold semantics (derived thread state)

| Derived field | Rule |
|---|---|
| `file` | latest of `created.file` / `renamed.file` |
| `anchor` | latest of `created.anchor` / `reanchored.anchor` |
| `status` | latest of `created`(→open) / `resolved`(→resolved) / `reopened`(→open) |
| `severity` | latest of `created.severity` / `severity_changed.severity` |
| `comments[]` | all `created`/`replied` in fold order, body overridden by latest `edited`, hidden by `comment_deleted` |
| `claim` | live-claim rule above |
| `suggestions[]` | `suggested` events with accepted/rejected status from latest matching event |

Semantic merge conflicts (e.g. one branch resolves while another replies) need no special handling: both events survive the union merge, the fold applies both, and the result — a resolved thread containing the reply — is visible and reversible (`reopened`).

## Anchors

```json
{
  "baseline": { "kind": "commit", "sha": "9c41f2e…" },
  "start": { "line": 18, "char": 6 },
  "end":   { "line": 19, "char": 17 },
  "text": "await sleep(delay);\n      delay *= 2;",
  "prefix": "…up to 120 chars…",
  "suffix": "…up to 120 chars…"
}
```

- Positions are 0-based and **exact at the baseline**: `text` is verbatim what `file`'s content at the baseline contains at `[start, end)`.
- `baseline.kind`:
  - `"commit"` — `sha` is a commit; the reference content is that commit's blob of `file`. Used when the file was clean at capture.
  - `"blob"` — `sha` is a git blob hash of the buffer content at capture (`git hash-object -w`, which persists it in the odb; equivalently computable as SHA-1 of `"blob <len>\0" + content` without invoking git). Used for dirty captures. Writers SHOULD also record `commit` (the HEAD at capture) for diff-locality hints.
  - `null` — legacy/unknown baseline (migrated v1 anchors that could not be re-baselined). Resolvers fall back to the fuzzy path.
- `text`/`prefix`/`suffix` are retained solely as the **last-resort** fuzzy key and for human display of orphans.

### Resolution algorithm (normative order)

1. **Live delta tracking** — while the file is open in an editor, shift positions with exact edit deltas (`onDidChangeTextDocument`). In-memory only.
2. **Diff translation** — otherwise, `git diff <baseline>..<current>` for the file; translate positions through hunks. Deterministic except when the anchored range itself is inside a modified hunk.
3. **Fuzzy** — the v1 three-tier matcher, only when 1–2 are unavailable or ambiguous. Must be surfaced as fuzzy in UI and, if persisted, recorded as `reanchored(method: "fuzzy")`.
4. **Orphan** — no match. Thread renders as orphaned; manual re-pin emits `reanchored(method: "manual")`.

Sidecar writes never persist drift silently: a persisted position change is always an explicit `reanchored` event with a fresh baseline. (This deletes v1's write-back-on-load behavior.)

### Re-baselining

When the workspace commits changes to `file`, the extension (or notary) translates the anchor to the new commit and appends `reanchored(method: "delta" | "diff")` with `baseline: { kind: "commit", sha: <new HEAD> }`. Blob baselines are thereby temporary: they exist only between a dirty capture and the next commit of that file.

## Pruning and history queries

- Resolving a thread does **not** delete its file. A separate prune step (manual command, or the notary's metadata commit) deletes `threads/<id>.jsonl` from the working tree for threads resolved before the current landing.
- Pruned threads are recovered via `git log --all -- .comments/threads/<id>.jsonl` and `git show <sha>:.comments/threads/<id>.jsonl`. Tools MUST NOT treat a missing thread file as "never existed."
- Line-history queries ("all threads ever on this line"): walk `git log -L<start>,<end>:<file>`, and at each ancestry commit read that commit's `threads/` tree; anchors there hold positions exact at (or translatable to) that commit, so overlap tests are range lookups — no fuzzy matching on the historical path.

## Migration from v1

One-shot, performed by the extension (command: **Comments: Migrate sidecars to v2**) or the CLI. In a single commit:

1. For each v1 sidecar `<path>.json`, for each thread:
   - Resolve the v1 anchor against the current file with the legacy fuzzy resolver.
   - If resolved: emit `created` (ts = first comment's `createdAt`, actor = first comment's author, kind `human`) with a fresh baseline — `commit` HEAD if the file is clean, else `blob`.
   - If orphaned: emit `created` with the legacy positions and `baseline: null`.
   - Emit `replied` per subsequent comment (their original `ts`/authors). v1 `status: "resolved"` migrates as `resolved` with `reason: "unknown"` (the historic reason is unrecoverable) and `ts` = the last comment's `createdAt`. Readers MUST accept `"unknown"` as a reason on migrated threads.
   - Thread ids are preserved (prefixed to `th_<old-uuid>`) so existing `claude:`-style cross-references keep working.
2. Delete the v1 sidecar files.
3. Write the `.gitattributes` union-merge line.

Readers encountering `version: 1` documents after migration (e.g. on old branches) MUST still parse them read-only.

## MCP surface (v2)

`bin/mcp-comments.js` keeps its zero-dependency contract and reads/writes the event-log format directly.

- Existing tools keep their names and response shapes (`list_threads`, `get_thread`, `create_thread`, `reply_to_thread`, `resolve_thread`), now implemented as fold-reads and event-appends. `create_thread` captures a baseline (blob hash computed in-process; commit sha via `git rev-parse HEAD` when available). `resolve_thread` gains `reason`.
- New tools: `claim_thread` / `release_thread` (leases), `set_severity`, `attach_suggestion` (patch), `re_anchor_thread` (agent-driven orphan repair; emits `reanchored(method: "manual")` with the agent as actor).
- All writers resolve the live store per the Store model (git common dir → primary worktree; `$MD_COMMENTS_ROOT` overrides) and append under the per-thread lockfile, so the extension, concurrent MCP processes, and the notary share one serialized view and never corrupt a log.

## Compatibility rules

- `version` lives in the `created` event (`"version": 2`). Breaking changes bump it; readers reject higher majors.
- Unknown event types and unknown fields: preserve on rewrite, ignore on fold (forward compatibility).
- The format is a public contract (README "Storage format"): the extension, the MCP server, the notary CLI, and third-party tools all read it. Changes land in this spec first.
