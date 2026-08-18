# Comments (anchored-comments) — VS Code extension

Read `docs/spec/*.md` first — the sidecar format, commit trailers, session providers, and the notary are public contracts, and changes go spec-first.

Google-Docs-style anchored comment threads for any file, persisted as committable sidecars under `.comments/`, with Claude Code conversation deeplinks and a bundled MCP server. See README.md for the full feature reference.

## Commands

```bash
npm test                 # tier 1: tsc + node --test (run before considering any change done)
npm run test:integration # tier 2: extension-host tests in real VS Code, hermetic git fixture repo
npm run test:ui          # tier 3: Playwright driving desktop VS Code (opens windows locally)
npm run bundle           # esbuild -> dist/extension.js (what the VSIX ships)
npx @vscode/vsce package --allow-missing-repository --skip-license   # build .vsix
```

Tiers 2–3 test the **bundle**, not `out/` — they run `npm run bundle` first. Integration suites live in `tests/integration/suite/*.test.js` (plain JS, mocha bdd, get the extension API via `activateExtension()` in `util.js`); UI specs in `tests/ui/*.spec.js`. Notes that cost debugging time: `onDidRenameFiles` only fires for `WorkspaceEdit`/user gestures (not `workspace.fs.rename`); never `await` a notification with buttons in a command that returns a value; VS Code can return cached TextDocuments with stale content (re-baselining guards against this by comparing the buffer to the HEAD blob).

There is no linter configured. TypeScript is strict; keep it compiling with zero errors.

## Architecture notes

- `src/` compiles with tsc to `out/` for tests, but the shipped extension is the esbuild bundle in `dist/` (`main` in package.json). Both must stay working.
- `src/refs.ts`, `src/sessions.ts`, and `src/sessionProviders.ts` must not import `vscode` — tests require them directly from `out/`.
- `bin/mcp-comments.js` is standalone plain JS with zero dependencies (it runs under `node` outside the extension host). Do not import extension code from it; it duplicates the sidecar format on purpose.
- Sidecar format (v2: per-thread JSONL event logs, docs/spec/sidecar-v2.md) is a public contract; the MCP server, extension, and any third-party tooling all read it. Change the spec first; version-gate breaking changes via the `version` field on `created` events. Same discipline for commit trailers (docs/spec/commit-trailers.md) and providers (docs/spec/session-providers.md) — both are stamped into published history, so legacy spellings stay readable forever (`Claude-Session:`, bare unscheme'd refs).
- `skills/` ships in the VSIX and is installed into a user's environment by **Comments: Install Agent Skill**. Claude reads workspace-local skills; Codex only discovers them under `$CODEX_HOME`. `.claude/skills/comment-cycle` is a symlink into `skills/` so this repo dogfoods the same file it ships.
- `src/threadLog.ts` and `src/baseline.ts` must not import `vscode` (like refs.ts/sessions.ts) — tests require them from `out/`.
- **Provider paths must be overridable by env** (`CODEX_HOME`, `MD_COMMENTS_CURSOR_HOME`, `MD_COMMENTS_CURSOR_STATE_DB`). A provider that resolves straight off `os.homedir()` can only be tested against whatever happens to be on the developer's machine, which is how cursor discovery shipped untested. Add the override with the provider, not after.
- **Editor state paths are per-platform.** Cursor's state DB lives under `~/Library/Application Support` (darwin), `%APPDATA%` (win32), `$XDG_CONFIG_HOME`/`~/.config` (linux). Getting it wrong fails *silently* — features just never light up — so these are covered by a platform-matrix test.
- **Agent providers** (docs/spec/session-providers.md): locating a transcript, naming a session (`claude:`/`codex:` refs), and extracting its file ops are the ONLY places an agent's identity may leak in. Adding a third agent should mean adding a provider, never touching anchors/landing/memory. `bin/lib/session-providers.js` (plain JS, node builtins only — required by both bin/ entry points) and `src/sessionProviders.ts` (extension side, returns editor shapes) are a deliberate mirror: keep the ref grammar and locate rules in sync, and the shared unit tests in `tests/sessionProviders.test.js` assert both implementations agree.
- Webviews (`media/graph.js`, `media/preview.js`) build DOM via helpers, not innerHTML (except extension-rendered markdown HTML in the preview). Keep CSP nonces intact.
- Session JSONL parsing: real files interleave meta entry types (`attachment`, `ai-title`, `queue-operation`, …) and parent chains route *through* them — see `nearestKeptAncestor` in sessions.ts. Sessions can contain multiple roots (continuation/compaction); each root is a sequential spine segment.

## Testing changes by hand

Package + `code --install-extension anchored-comments-<version>.vsix --force`, then reload the VS Code window. The CLI lives at `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code` if `code` is not on PATH.
