const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadSessionGraph } = require('../out/sessions.js');

const FIXTURES = path.join(__dirname, 'fixtures');

test('parses subagent linkage and transcripts (claude-code-transcripts convention)', () => {
  const g = loadSessionGraph(FIXTURES, 'parent-session');
  assert.equal(g.messages.length, 5);
  assert.deepEqual(g.mainPath, ['u1', 'a1', 'u2', 'u3', 'a2']);
  assert.equal(g.forks.length, 0);
  assert.equal(g.subagents.length, 2);
  const a = g.subagents.find((x) => x.agentId === 'aaa111');
  assert.equal(a.spawnUuid, 'a1');
  assert.equal(a.description, 'Explore repo A');
  assert.equal(a.messages.length, 4);
  assert.equal(a.totalToolUseCount, 7);
  const spawner = g.messages.find((m) => m.uuid === 'a1');
  assert.deepEqual(spawner.spawns, ['aaa111', 'bbb222']);
});

test('detects abandoned forks from parentUuid branches', () => {
  const g = loadSessionGraph(FIXTURES, 'forked');
  assert.deepEqual(g.mainPath, ['m1', 'm4', 'm5']);
  assert.equal(g.forks.length, 1);
  assert.deepEqual(g.forks[0], { fromUuid: 'm1', uuids: ['m2', 'm3'] });
  assert.equal(g.title, 'Fix the retry bug');
});

test('missing session returns undefined', () => {
  assert.equal(loadSessionGraph(FIXTURES, 'nope'), undefined);
});
