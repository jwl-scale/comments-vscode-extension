# Spec: Agent-session providers — refs, transcript location, and file-op extraction

**Status:** draft for review
**Companions:** [commit-trailers.md](commit-trailers.md), [notary.md](notary.md), [sidecar-v2.md](sidecar-v2.md)

## Purpose

Comments binds code to the *conversation that produced it*. Until v0.12 that conversation was always a Claude Code session: transcripts were located under `~/.claude/projects`, refs were spelled `claude:<sid>`, and provenance was verified by replaying `Edit`/`Write`/`MultiEdit` tool calls.

Those three concerns — **locate**, **name**, **extract** — are the only places the coding agent's identity leaks into the system. This spec factors them into a **provider** contract so a second agent (Codex CLI) is an implementation rather than a fork, and so a third is a day of work rather than a redesign.

Everything else in the system — anchors, event logs, the gate, landing, re-anchoring, memory — is provider-independent and MUST remain so.

## Agent-session refs

The ref grammar generalizes `claude:<sid>` to a scheme-qualified form:

```
<scheme>:<sessionId>                      whole session
<scheme>:<sessionId>#<uuid>               one message
<scheme>:<sessionId>#<uuid1>..<uuid2>     message segment (inclusive)
<scheme>:<sessionId>@<agentId>            a subagent transcript
```

- `<scheme>` matches `[a-z][a-z0-9-]{0,15}`. Registered schemes: **`claude`**, **`codex`**.
- `<sessionId>` and `<uuid>` match `[A-Za-z0-9_-]+`. Their internal structure is provider-defined and MUST be treated as opaque by everything outside the provider.
- **A ref with no scheme means `claude`.** This is the compatibility rule that makes every ref written before v0.12 valid, in comment bodies, trailers, and `actor.session` fields alike. Writers at v0.12+ SHOULD always emit the scheme.
- Providers MUST reject a ref whose scheme they do not own rather than attempting a best-effort parse.

`@`-mentions in comment bodies follow the same grammar (`@codex:<sid>#<uuid>` forks that Codex session), with the bare `@claude` / `@codex` forms dispatching that provider's default agent.

## The provider contract

A provider is three pure functions over a session id and the local filesystem. None of them may import `vscode`.

### `locate(sessionId, root) → path | null`

Resolve a session id to its transcript on this machine.

- Providers MUST check the repository's vendored copy first (`<root>/.comments/sessions/<sessionId>.jsonl`) and return it if present. Vendored transcripts are the archival record: a clone with no local agent history must still verify and render landed provenance.
- Failing that, providers search their own local store. Resolution is best-effort and machine-local; `null` is a normal result, not an error.
- `locate` MUST NOT be given a scheme-qualified ref; callers split the scheme first and dispatch.

### `parse(path) → { messages, segment }`

Normalize a transcript into the provider-independent shape the conversation graph renders: an ordered list of messages, each with an opaque `id`, a role, text content, and tool calls. Providers that expose no reply tree (Codex) return a linear spine; providers that do (Claude) return the parent-linked graph. Consumers MUST NOT assume a tree.

### `extractFileOps(path, root, changedFiles) → { ops, segment }`

The provenance primitive. Return the file mutations the session performed, in order, each reduced to one of two forms:

| Form | Fields | Meaning |
|---|---|---|
| content op | `{ file, apply(prev) → next }` | A whole-file write or an in-place edit whose result is computable from the prior content. |
| patch op | `{ patch }` | A unified diff to apply to the replay tree. |

Ops MUST be ordered by the transcript's own chronology, including any subagent transcripts the provider merges in. `segment` is the `{ from, to }` pair of **main-transcript** message ids spanning the ops — subagent ids never appear in a segment, because segments are what deeplinks resolve.

Mutations a provider cannot observe (shell redirection, `sed`, a script the agent wrote and ran) are simply absent from `ops`. That is the mechanism by which such changes verify `hybrid`: absence is not an error, it is the signal. Providers MUST NOT guess.

## Registered providers

### `claude` — Claude Code

- **Locate:** `~/.claude/projects/<slug>/<sessionId>.jsonl`, searching all project slugs (a session may have been recorded under a different cwd).
- **Subagents:** `~/.claude/projects/<slug>/<sessionId>/subagents/agent-*.jsonl`, merged into the main transcript by timestamp. Task-tool workers' edits therefore count toward the dispatching session's provenance.
- **File ops:** `tool_use` entries named `Edit`, `Write`, or `MultiEdit` with an `input.file_path`, emitted as content ops; `attach_suggestion` calls carrying a `patch` string, emitted as patch ops.
- **Message ids:** entry `uuid`; the reply tree is `parentUuid`, routed through meta entry types (see `nearestKeptAncestor`).

### `codex` — Codex CLI

- **Locate:** `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<sessionId>.jsonl` (`~/.codex` when `CODEX_HOME` is unset). The session id is the trailing UUID of the filename, so location is a bounded filename scan rather than a content scan.
- **Subagents:** none at time of writing; the provider returns main-transcript ops only.
- **File ops:** `event_msg` entries of type `patch_apply_end` with `success: true`. Each carries `changes[<absolute path>].unified_diff` — the diff that was actually applied, per file — emitted directly as patch ops. Entries with `success: false` MUST be skipped: a rejected patch changed nothing.
- **Message ids:** `response_item` ids (`id` on the item). Codex rollouts are a linear sequence with no parent links; `compacted` entries begin a new spine segment, handled the same way as Claude's multi-root continuation case.

The Codex provider is *more* direct than the Claude one: it does not reconstruct intent from edit parameters, it reads the applied diff. Its `ops` are consequently patch ops almost exclusively, reusing the replay machinery already built for suggestions.

### Path mapping (both providers)

Transcripts record absolute paths, and agents routinely work in isolated worktrees whose absolute paths differ from the landing root. Providers MUST map a recorded path to a root-relative one by:

1. relativizing against `root`; if the result does not escape, use it;
2. otherwise matching the recorded path's suffix against the candidate's `changedFiles`, accepting **only a unique match**.

An ambiguous or unmatched path is dropped from `ops` (→ contributes to `hybrid`), never guessed at.

## Provenance is unchanged

Adding a provider does not add a way to *claim* provenance. The notary's verification procedure ([notary.md](notary.md)) is identical for every provider: replay `ops` against the parent tree, compare to the candidate's tree, stamp `agent` only on an exact match. `Provenance: agent` remains a verification result that only the notary may write, and a provider that reported ops dishonestly would fail the comparison, not pass it.

## Compatibility

- Readers MUST accept the legacy `Claude-Session:` trailer as an `Agent-Session:` line with scheme `claude` (see [commit-trailers.md](commit-trailers.md)).
- Readers MUST accept unscheme'd refs in comment bodies, `actor.session` fields, and trailers as `claude`.
- The `version` field on `created` events does not change: this revision adds no event types and no required fields, so a v0.12 store is readable by a v0.11 client with no loss beyond scheme awareness.
