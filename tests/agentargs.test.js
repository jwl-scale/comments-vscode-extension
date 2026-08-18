const { test } = require('node:test');
const assert = require('node:assert');

const { buildAgentArgs, lastSessionId, DEFAULT_MCP_TOOLS } = require('../out/agentArgs.js');

const base = { prompt: 'do it', mcpConfigJson: '{}', newSessionId: 'new-uuid-1' };

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

test('session auto: fork beats continue beats fresh', () => {
  const fork = buildAgentArgs({ ...base, options: {}, mentionSessionId: 'sid-m', threadLastSessionId: 'sid-t' });
  assert.equal(fork.sessionMode, 'fork');
  assert.equal(flag(fork.args, '--resume'), 'sid-m');
  assert.ok(fork.args.includes('--fork-session'));
  assert.equal(fork.knownSessionId, undefined, 'forked id unknowable pre-run');

  const cont = buildAgentArgs({ ...base, options: {}, threadLastSessionId: 'sid-t' });
  assert.equal(cont.sessionMode, 'continue');
  assert.equal(flag(cont.args, '--resume'), 'sid-t');
  assert.ok(!cont.args.includes('--fork-session'));
  assert.equal(cont.knownSessionId, 'sid-t', 'continued session id known → MCP stamping works');

  const fresh = buildAgentArgs({ ...base, options: {} });
  assert.equal(fresh.sessionMode, 'fresh');
  assert.equal(flag(fresh.args, '--session-id'), 'new-uuid-1');
  assert.equal(fresh.knownSessionId, 'new-uuid-1');
});

test('explicit modes degrade gracefully when there is nothing to resume', () => {
  const forcedContinue = buildAgentArgs({ ...base, options: { sessionMode: 'continue' } });
  assert.equal(forcedContinue.sessionMode, 'fresh');
  const forcedFork = buildAgentArgs({ ...base, options: { sessionMode: 'fork' } });
  assert.equal(forcedFork.sessionMode, 'fresh');
  const forcedFresh = buildAgentArgs({ ...base, options: { sessionMode: 'fresh' }, threadLastSessionId: 'sid-t' });
  assert.equal(forcedFresh.sessionMode, 'fresh', 'fresh overrides sticky continuation');
});

test('flag mapping: model, permissions, turns, prompts, tools, extra args', () => {
  const { args } = buildAgentArgs({
    ...base,
    options: {
      model: 'opus',
      permissionMode: 'acceptEdits',
      maxTurns: 12,
      appendSystemPrompt: 'be terse',
      allowedTools: ['mcp__comments__reply_to_thread', 'Edit'],
      extraArgs: ['--effort', 'high'],
    },
    agentSystemPrompt: 'you are the security reviewer',
  });
  assert.equal(flag(args, '--model'), 'opus');
  assert.equal(flag(args, '--permission-mode'), 'acceptEdits');
  assert.equal(flag(args, '--max-turns'), '12');
  assert.equal(flag(args, '--allowedTools'), 'mcp__comments__reply_to_thread,Edit');
  assert.equal(flag(args, '--append-system-prompt'), 'you are the security reviewer\n\nbe terse');
  assert.deepEqual(args.slice(-2), ['--effort', 'high'], 'extraArgs appended last');
});

test('defaults: comments MCP toolset, no permission-mode flag for default, stream-json always', () => {
  const { args } = buildAgentArgs({ ...base, options: { permissionMode: 'default' } });
  assert.equal(flag(args, '--allowedTools'), DEFAULT_MCP_TOOLS.join(','));
  assert.ok(!args.includes('--permission-mode'));
  assert.equal(flag(args, '--output-format'), 'stream-json');
  assert.ok(args.includes('--verbose'));
});

test('lastSessionId picks the newest stamped event', () => {
  assert.equal(
    lastSessionId([
      { actor: { session: 'old' } },
      { actor: {} },
      { actor: { session: 'newest' } },
      { actor: {} },
    ]),
    'newest',
  );
  assert.equal(lastSessionId([{ actor: {} }]), undefined);
});

test('system prompt replace + effort map to first-class flags', () => {
  const { args } = buildAgentArgs({
    ...base,
    options: { replaceSystemPrompt: 'you are a pirate', appendSystemPrompt: 'arr', effort: 'high' },
    agentSystemPrompt: 'agent def',
  });
  assert.equal(flag(args, '--system-prompt'), 'you are a pirate');
  assert.equal(flag(args, '--append-system-prompt'), 'agent def\n\narr', 'replace and append compose');
  assert.equal(flag(args, '--effort'), 'high');

  const none = buildAgentArgs({ ...base, options: {} });
  assert.ok(!none.args.includes('--system-prompt'));
  assert.ok(!none.args.includes('--effort'));
});

// ---------- codex flag mapping ----------

const { buildCodexArgs, codexSessionIdFromEvent } = require('../out/agentArgs.js');

test('codex: fresh run wires the comments MCP server and cannot know its id up front', () => {
  const built = buildCodexArgs({
    prompt: 'address th_x',
    mcpServerPath: '/ext/bin/mcp-comments.js',
    options: { sessionMode: 'fresh' },
  });
  assert.equal(built.sessionMode, 'fresh');
  // No --session-id exists in codex exec: the id is read back off --json.
  assert.equal(built.knownSessionId, undefined);
  assert.equal(built.args[0], 'exec');
  assert.ok(built.args.includes('--json'));
  assert.ok(built.args.includes('mcp_servers.comments.command="node"'));
  assert.ok(built.args.includes('mcp_servers.comments.args=["/ext/bin/mcp-comments.js"]'));
  // Prompt is positional and last.
  assert.equal(built.args[built.args.length - 1], 'address th_x');
});

test('codex: permission modes map onto sandbox policies', () => {
  const sandbox = (permissionMode, extra = {}) => {
    const a = buildCodexArgs({ prompt: 'p', options: { permissionMode, sessionMode: 'fresh' }, ...extra }).args;
    const hit = a.find((x) => typeof x === 'string' && x.startsWith('sandbox_mode='));
    return hit && hit.slice('sandbox_mode="'.length, -1);
  };
  assert.equal(sandbox('plan'), 'read-only');
  assert.equal(sandbox('bypassPermissions'), 'danger-full-access');
  assert.equal(sandbox('acceptEdits'), 'workspace-write');
  assert.equal(sandbox(undefined), 'workspace-write');
});

/**
 * `codex exec resume` accepts a STRICT SUBSET of `codex exec`'s options —
 * notably no --sandbox, -C/--cd, --add-dir, or --profile — and rejects unknown
 * flags at parse time rather than ignoring them. Emitting one would break every
 * continue/fork run, so pin the allowed set here. Sourced from
 * `codex exec resume --help` (codex-cli 0.146.1).
 */
const RESUME_SAFE_FLAGS = new Set([
  '-c', '--config', '--last', '--all', '--enable', '--disable', '-i', '--image',
  '--strict-config', '-m', '--model', '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--ephemeral',
  '--ignore-user-config', '--ignore-rules', '--output-schema', '--json',
  '-o', '--output-last-message',
]);

test('codex: resume never emits a flag the resume subcommand rejects', () => {
  for (const permissionMode of ['plan', 'acceptEdits', 'bypassPermissions', undefined]) {
    const built = buildCodexArgs({
      prompt: 'continue please',
      mcpServerPath: '/ext/bin/mcp-comments.js',
      options: { permissionMode, effort: 'high', model: 'gpt-5.6-sol', sessionMode: 'continue' },
      threadLastSessionId: 'sid-prev',
    });
    assert.deepEqual(built.args.slice(0, 3), ['exec', 'resume', 'sid-prev']);
    assert.ok(!built.args.includes('--sandbox'), '--sandbox is not valid on exec resume');

    // Every dash-prefixed token must be a known resume option (values may look
    // like anything, so only check tokens in flag position).
    for (const tok of built.args) {
      if (typeof tok === 'string' && tok.startsWith('-') && tok !== '-') {
        assert.ok(
          RESUME_SAFE_FLAGS.has(tok),
          `${tok} is not accepted by 'codex exec resume' (permissionMode=${permissionMode})`,
        );
      }
    }
  }
});

test('codex: continue resumes; fork degrades to resume (exec has no fork)', () => {
  const cont = buildCodexArgs({
    prompt: 'more',
    options: { sessionMode: 'continue' },
    threadLastSessionId: 'sid-prev',
  });
  assert.deepEqual(cont.args.slice(0, 3), ['exec', 'resume', 'sid-prev']);
  assert.equal(cont.knownSessionId, 'sid-prev');

  const fork = buildCodexArgs({
    prompt: 'more',
    options: { sessionMode: 'fork' },
    mentionSessionId: 'sid-mention',
  });
  assert.deepEqual(fork.args.slice(0, 3), ['exec', 'resume', 'sid-mention']);
});

test('codex: system prompts are prepended, since exec has no flag for them', () => {
  const built = buildCodexArgs({
    prompt: 'the task',
    options: { sessionMode: 'fresh', appendSystemPrompt: 'be terse' },
    agentSystemPrompt: 'you are a reviewer',
  });
  const prompt = built.args[built.args.length - 1];
  assert.match(prompt, /you are a reviewer/);
  assert.match(prompt, /be terse/);
  assert.match(prompt, /the task$/);
});

test('codex: session id is recovered from the --json event stream', () => {
  assert.equal(
    codexSessionIdFromEvent('{"session_id":"019fdde4-42e3-74b2-8a56-d072b23ef056"}'),
    '019fdde4-42e3-74b2-8a56-d072b23ef056',
  );
  assert.equal(
    codexSessionIdFromEvent('{"payload":{"id":"019fdde4-42e3-74b2-8a56-d072b23ef056"}}'),
    '019fdde4-42e3-74b2-8a56-d072b23ef056',
  );
  assert.equal(codexSessionIdFromEvent('{"payload":{"id":"not-a-uuid"}}'), undefined);
  assert.equal(codexSessionIdFromEvent('garbage'), undefined);
});
