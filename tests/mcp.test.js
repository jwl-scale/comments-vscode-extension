const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'bin', 'mcp-comments.js');

/** Drive the MCP server over stdio: send requests, resolve responses by id. */
function startServer(root, extraEnv = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MD_COMMENTS_ROOT: root, ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  let seq = 0;
  return {
    request(method, params) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000).unref();
      });
    },
    close() {
      proc.stdin.end();
      proc.kill();
    },
  };
}

function callResult(resp) {
  assert.ok(!resp.error, JSON.stringify(resp.error));
  assert.ok(!resp.result.isError, resp.result.content?.[0]?.text);
  return JSON.parse(resp.result.content[0].text);
}

test('MCP server: full thread lifecycle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-mcp-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'function main() {\n  return 42;\n}\n');
  const server = startServer(root);
  try {
    const init = await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'anchored-comments');

    const tools = await server.request('tools/list', {});
    assert.deepEqual(
      tools.result.tools.map((t) => t.name).sort(),
      [
        'attach_suggestion',
        'claim_thread',
        'create_thread',
        'dispatch_agent',
        'get_commit_context',
        'get_thread',
        'list_threads',
        're_anchor_thread',
        'register_session',
        'release_thread',
        'reply_to_thread',
        'resolve_thread',
        'search_reasoning',
        'set_severity',
      ],
    );

    const created = callResult(
      await server.request('tools/call', {
        name: 'create_thread',
        arguments: { file: 'src/app.ts', anchorText: 'return 42;', body: 'why 42? see notes.md:1' },
      }),
    );
    assert.equal(created.startLine, 2);
    assert.equal(created.anchorText, 'return 42;');
    assert.equal(created.comments[0].author, 'claude');

    // v2: one append-only event log per thread under .comments/threads/.
    const threadsDir = path.join(root, '.comments', 'threads');
    const logs = fs.readdirSync(threadsDir).filter((n) => n.endsWith('.jsonl'));
    assert.equal(logs.length, 1);
    assert.equal(logs[0], `${created.threadId}.jsonl`);
    const events = fs
      .readFileSync(path.join(threadsDir, logs[0]), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(events[0].type, 'created');
    assert.equal(events[0].seq, 1);
    assert.equal(events[0].file, 'src/app.ts');
    assert.equal(events[0].anchor.prefix.includes('function main'), true);
    assert.equal(events[0].actor.kind, 'agent');

    const listed = callResult(
      await server.request('tools/call', { name: 'list_threads', arguments: { status: 'open' } }),
    );
    assert.equal(listed.length, 1);

    const replied = callResult(
      await server.request('tools/call', {
        name: 'reply_to_thread',
        arguments: { threadId: created.threadId, body: 'fixed in abc123' },
      }),
    );
    assert.equal(replied.comments.length, 2);

    const resolved = callResult(
      await server.request('tools/call', {
        name: 'resolve_thread',
        arguments: { threadId: created.threadId },
      }),
    );
    assert.equal(resolved.status, 'resolved');

    const errored = await server.request('tools/call', {
      name: 'create_thread',
      arguments: { file: '../etc/passwd', body: 'nope' },
    });
    assert.equal(errored.result.isError, true);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP server: claims, severity, suggestions, re-anchor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-mcp2-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'function main() {\n  return 42;\n}\n');
  const server = startServer(root);
  const call = async (name, args) => {
    const resp = await server.request('tools/call', { name, arguments: args });
    return { data: resp.result.isError ? null : JSON.parse(resp.result.content[0].text), raw: resp.result };
  };
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const { data: created } = await call('create_thread', {
      file: 'src/app.ts',
      anchorText: 'return 42;',
      body: 'why 42?',
    });

    // Claim: second actor is rejected while the lease is live; release frees it.
    const { data: claimed } = await call('claim_thread', { threadId: created.threadId, author: 'fixer-a' });
    assert.equal(claimed.claimedBy, 'fixer-a');
    const { raw: conflict } = await call('claim_thread', { threadId: created.threadId, author: 'fixer-b' });
    assert.equal(conflict.isError, true);
    await call('release_thread', { threadId: created.threadId, author: 'fixer-a' });
    const { data: reclaimed } = await call('claim_thread', { threadId: created.threadId, author: 'fixer-b' });
    assert.equal(reclaimed.claimedBy, 'fixer-b');

    const { data: blocking } = await call('set_severity', { threadId: created.threadId, severity: 'blocking' });
    assert.equal(blocking.severity, 'blocking');

    const { data: suggested } = await call('attach_suggestion', {
      threadId: created.threadId,
      patch: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n function main() {\n-  return 42;\n+  return 43;\n }\n',
    });
    assert.equal(suggested.suggestions.length, 1);
    assert.equal(suggested.suggestions[0].status, 'open');

    // Re-anchor: the file was rewritten; agent re-pins the thread by text.
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), '// rewritten\nfunction main() {\n  return answer();\n}\n');
    const { data: repinned } = await call('re_anchor_thread', {
      threadId: created.threadId,
      anchorText: 'return answer();',
    });
    assert.equal(repinned.anchorText, 'return answer();');
    assert.equal(repinned.startLine, 3);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP server: MD_COMMENTS_SESSION stamps actor.session on every write', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-mcp3-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
  const server = startServer(root, { MD_COMMENTS_SESSION: 'sess-abc-123' });
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const created = callResult(
      await server.request('tools/call', {
        name: 'create_thread',
        arguments: { file: 'a.ts', anchorText: 'const a = 1;', body: 'from an agent run' },
      }),
    );
    callResult(
      await server.request('tools/call', {
        name: 'reply_to_thread',
        arguments: { threadId: created.threadId, body: 'follow-up' },
      }),
    );
    const events = fs
      .readFileSync(path.join(root, '.comments', 'threads', `${created.threadId}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(events.length, 2);
    for (const ev of events) assert.equal(ev.actor.session, 'sess-abc-123');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dispatch_agent: spawns a configured worker, returns sessionId, thread events track it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-mcp4-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
  // Fake worker: records argv, replies to the thread stamped with its session.
  const fake = path.join(root, 'fake-worker.js');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.env.MD_COMMENTS_ROOT, 'worker-argv.json'), JSON.stringify(process.argv.slice(2)));
const sid = process.argv[process.argv.indexOf('--session-id') + 1];
const threadId = process.argv[process.argv.indexOf('-p') + 1].match(/th_[A-Za-z0-9-]+/)[0];
const log = path.join(process.env.MD_COMMENTS_ROOT, '.comments', 'threads', threadId + '.jsonl');
const seq = fs.readFileSync(log, 'utf8').trim().split('\\n')
  .map((l) => { try { return JSON.parse(l).seq || 0; } catch { return 0; } })
  .reduce((a, b) => Math.max(a, b), 0) + 1;
fs.appendFileSync(log, JSON.stringify({
  id: 'ev_w_' + Math.random().toString(36).slice(2), type: 'replied', seq,
  ts: new Date().toISOString(), actor: { name: 'reviewer', kind: 'agent', session: sid },
  commentId: 'c_worker', body: 'worker checked in',
}) + '\\n');
`,
    { mode: 0o755 },
  );
  const server = startServer(root, { MD_COMMENTS_CLAUDE: fake });
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const created = callResult(
      await server.request('tools/call', {
        name: 'create_thread',
        arguments: { file: 'a.ts', anchorText: 'const a = 1;', body: 'is this constant right?', author: 'jon' },
      }),
    );
    const dispatched = callResult(
      await server.request('tools/call', {
        name: 'dispatch_agent',
        arguments: {
          threadId: created.threadId,
          agentName: 'reviewer',
          model: 'haiku',
          effort: 'low',
          maxTurns: 3,
          instructions: 'be brief',
        },
      }),
    );
    assert.equal(dispatched.dispatched, true);
    assert.ok(dispatched.sessionId);
    assert.equal(dispatched.mode, 'fresh');

    // Worker reply lands, stamped with the session; claim released on exit.
    const deadline = Date.now() + 8000;
    let state;
    for (;;) {
      state = callResult(
        await server.request('tools/call', { name: 'get_thread', arguments: { threadId: created.threadId } }),
      );
      if (state.comments.length === 2 && !state.claimedBy) break;
      if (Date.now() > deadline) throw new Error('worker did not complete: ' + JSON.stringify(state));
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(state.comments[1].body, 'worker checked in');

    // Config surface passed through to the CLI.
    const argv = JSON.parse(fs.readFileSync(path.join(root, 'worker-argv.json'), 'utf8'));
    const flag = (name) => argv[argv.indexOf(name) + 1];
    assert.equal(flag('--model'), 'haiku');
    assert.equal(flag('--effort'), 'low');
    assert.equal(flag('--max-turns'), '3');
    assert.equal(flag('--session-id'), dispatched.sessionId);
    assert.match(flag('-p'), /be brief/);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MD_COMMENTS_AUTHOR attributes dispatched-worker events to the agent name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-mcp5-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
  const server = startServer(root, { MD_COMMENTS_SESSION: 'sess-rev-1', MD_COMMENTS_AUTHOR: 'reviewer' });
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const created = callResult(
      await server.request('tools/call', {
        name: 'create_thread',
        arguments: { file: 'a.ts', anchorText: 'const a = 1;', body: 'from a dispatched reviewer' },
      }),
    );
    const events = fs
      .readFileSync(path.join(root, '.comments', 'threads', `${created.threadId}.jsonl`), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.equal(events[0].actor.name, 'reviewer');
    assert.equal(events[0].actor.kind, 'agent');
    assert.equal(events[0].actor.session, 'sess-rev-1');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('register_session: presence registry under the git common dir, never committed', async () => {
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-mcp6-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const server = startServer(root);
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const reg = callResult(
      await server.request('tools/call', {
        name: 'register_session',
        arguments: { sessionId: 'sess-main-1', role: 'main', mission: 'fix issue #1532' },
      }),
    );
    assert.equal(reg.registered, true);
    const runFile = path.join(root, '.git', 'comments-runs', 'sess-main-1.json');
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    assert.equal(run.role, 'main');
    assert.equal(run.mission, 'fix issue #1532');
    const started = run.startedAt;

    // Re-register updates status, preserves startedAt.
    callResult(
      await server.request('tools/call', {
        name: 'register_session',
        arguments: { sessionId: 'sess-main-1', role: 'main', status: 'review round 2' },
      }),
    );
    const updated = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    assert.equal(updated.status, 'review round 2');
    assert.equal(updated.mission, 'fix issue #1532');
    assert.equal(updated.startedAt, started);
    // Presence lives under .git/ — structurally uncommittable.
    assert.ok(runFile.includes(`${path.sep}.git${path.sep}`));
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dispatch_agent hands off agent-held claims but never human claims; resolve is idempotent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-mcp7-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
  const fake = path.join(root, 'noop-worker.js');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  const server = startServer(root, { MD_COMMENTS_CLAUDE: fake });
  const call = async (name, args) => {
    const resp = await server.request('tools/call', { name, arguments: args });
    return { data: resp.result.isError ? null : JSON.parse(resp.result.content[0].text), raw: resp.result };
  };
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const { data: created } = await call('create_thread', { file: 'a.ts', anchorText: 'const a = 1;', body: 'q' });

    // Orchestrator (agent kind) holds the claim → dispatch hands off.
    await call('claim_thread', { threadId: created.threadId });
    const { data: d1 } = await call('dispatch_agent', { threadId: created.threadId, agentName: 'reviewer' });
    assert.equal(d1.dispatched, true, 'agent claim handed off, not rejected');

    // Human-held claim → dispatch refuses.
    await new Promise((r) => setTimeout(r, 300)); // let noop worker exit + release
    await call('claim_thread', { threadId: created.threadId, author: 'jon' });
    const { raw: refused } = await call('dispatch_agent', { threadId: created.threadId, agentName: 'reviewer' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /human/);
    await call('release_thread', { threadId: created.threadId, author: 'jon' });

    // resolve_thread is idempotent: second call appends nothing.
    await call('resolve_thread', { threadId: created.threadId, reason: 'wontfix' });
    await call('resolve_thread', { threadId: created.threadId });
    const events = fs
      .readFileSync(path.join(root, '.comments', 'threads', `${created.threadId}.jsonl`), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.equal(events.filter((e) => e.type === 'resolved').length, 1, 'no duplicate resolved event');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('get_commit_context + search_reasoning: blame-indexed memory over MCP', async () => {
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-mcp8-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'a.ts'), 'const retries = 3;\n');
  fs.mkdirSync(path.join(root, '.comments', 'threads'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.comments', 'threads', 'th_mem.jsonl'),
    JSON.stringify({
      id: 'ev_1', type: 'created', seq: 1, ts: '2026-08-01T00:00:00Z',
      actor: { name: 'jon', kind: 'human' }, version: 2, file: 'a.ts',
      anchor: { baseline: null, start: { line: 0, char: 0 }, end: { line: 0, char: 5 }, text: 'const', prefix: '', suffix: '' },
      body: 'we chose 3 retries because of thundering herd', commentId: 'c_1',
    }) + '\n',
  );
  g('add', '-A');
  g('commit', '-qm', 'fix: cap retries\n\nComments-Resolves: th_mem\nClaude-Session: sess-m#u1..u2\nProvenance: agent');
  const sha = g('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(root, '.comments', 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.comments', 'briefs', `${sha}.md`), `# brief\n- decision: cap retries at 3, no exponential blowup\n`);
  fs.mkdirSync(path.join(root, '.comments', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, '.comments', 'sessions', 'sess-m.jsonl'),
    JSON.stringify({ uuid: 'u1', message: { content: [{ type: 'text', text: 'considered jittered backoff but rejected it' }] } }) + '\n');

  const server = startServer(root);
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const ctx = callResult(
      await server.request('tools/call', { name: 'get_commit_context', arguments: { sha: sha.slice(0, 8) } }),
    );
    assert.equal(ctx.provenance, 'agent');
    assert.equal(ctx.session, 'claude:sess-m#u1..u2');
    assert.equal(ctx.threads[0].threadId, 'th_mem');
    assert.match(ctx.threads[0].comments[0].body, /thundering herd/);
    assert.match(ctx.brief, /cap retries at 3/);

    const hits = callResult(
      await server.request('tools/call', { name: 'search_reasoning', arguments: { query: 'jittered backoff' } }),
    );
    assert.equal(hits[0].source, 'session');
    assert.equal(hits[0].ref, 'claude:sess-m');
    const briefHits = callResult(
      await server.request('tools/call', { name: 'search_reasoning', arguments: { query: 'exponential blowup' } }),
    );
    assert.equal(briefHits[0].source, 'brief');
    assert.equal(briefHits[0].sha, sha);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
