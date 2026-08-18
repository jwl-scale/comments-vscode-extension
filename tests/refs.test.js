const { test } = require('node:test');
const assert = require('node:assert');
const { FILE_REF, CLAUDE_REF, focusFromMatch } = require('../out/refs.js');

function fileMatches(input) {
  return [...input.matchAll(FILE_REF)].map((m) => m[0]);
}
function claudeMatches(input) {
  return [...input.matchAll(CLAUDE_REF)].map((m) => ({ session: m[1], msg: m[2], rangeEnd: m[3], agent: m[4] }));
}

test('file refs with extensions and dirs', () => {
  assert.deepEqual(fileMatches('src/queue/consumer.ts:88-104 and retry.ts:19'), [
    'src/queue/consumer.ts:88-104',
    'retry.ts:19',
  ]);
});

test('extensionless refs need a slash or well-known name', () => {
  assert.deepEqual(fileMatches('mcpx-go/Dockerfile:1-2'), ['mcpx-go/Dockerfile:1-2']);
  assert.deepEqual(fileMatches('Dockerfile:9 and deploy/Makefile:14'), ['Dockerfile:9', 'deploy/Makefile:14']);
  assert.deepEqual(fileMatches('LICENSE:1'), ['LICENSE:1']);
  assert.deepEqual(fileMatches('a Dockerfileish:3 word'), []);
});

test('no false positives on times, errors, urls, claude refs', () => {
  assert.deepEqual(fileMatches('meeting at 12:30 with ratio 3:1'), []);
  assert.deepEqual(fileMatches('error TS2345: bad'), []);
  assert.deepEqual(fileMatches('http://x.com/a.ts:12'), []);
  assert.deepEqual(fileMatches('claude:8f2a1b3c#a3f9'), []);
});

test('claude refs: session, message, range, agent', () => {
  assert.deepEqual(claudeMatches('claude:abc-123'), [
    { session: 'abc-123', msg: undefined, rangeEnd: undefined, agent: undefined },
  ]);
  assert.deepEqual(claudeMatches('claude:abc#m1'), [
    { session: 'abc', msg: 'm1', rangeEnd: undefined, agent: undefined },
  ]);
  assert.deepEqual(claudeMatches('claude:abc#m1..m9'), [
    { session: 'abc', msg: 'm1', rangeEnd: 'm9', agent: undefined },
  ]);
  assert.deepEqual(claudeMatches('claude:abc@agent42'), [
    { session: 'abc', msg: undefined, rangeEnd: undefined, agent: 'agent42' },
  ]);
});

test('focusFromMatch', () => {
  assert.deepEqual(focusFromMatch('m1', undefined, undefined), { kind: 'msg', uuid: 'm1' });
  assert.deepEqual(focusFromMatch('m1', 'm9', undefined), { kind: 'range', from: 'm1', to: 'm9' });
  assert.deepEqual(focusFromMatch(undefined, undefined, 'a1'), { kind: 'agent', agentId: 'a1' });
  assert.equal(focusFromMatch(undefined, undefined, undefined), null);
});

const { parseMentions } = require('../out/refs.js');

test('mentions: agent names, default agents, session forks', () => {
  assert.deepEqual(parseMentions('@security-reviewer please take a look'), [
    { kind: 'agent', name: 'security-reviewer' },
  ]);
  assert.deepEqual(parseMentions('@claude fix this'), [{ kind: 'agent', name: 'claude' }]);
  assert.deepEqual(parseMentions('@codex fix this'), [{ kind: 'agent', name: 'codex' }]);
  assert.deepEqual(parseMentions('fork it: @claude:9c41d0ab#a3f9 and address'), [
    { kind: 'session', scheme: 'claude', sessionId: '9c41d0ab', messageUuid: 'a3f9' },
  ]);
  assert.deepEqual(parseMentions('@claude:9c41d0ab continue this'), [
    { kind: 'session', scheme: 'claude', sessionId: '9c41d0ab', messageUuid: undefined },
  ]);
  assert.deepEqual(parseMentions('@codex:019fdde4-42e3 take this one'), [
    { kind: 'session', scheme: 'codex', sessionId: '019fdde4-42e3', messageUuid: undefined },
  ]);
});

test('mentions: emails and mid-word @ are not mentions', () => {
  assert.deepEqual(parseMentions('email dev@example.com about foo@bar'), []);
  assert.deepEqual(parseMentions('no mention in path/@scope/pkg'), []);
});

test('mentions: session mention does not double-count as agent mention', () => {
  const mentions = parseMentions('@perf and @claude:abc123#m1 together');
  assert.deepEqual(mentions, [
    { kind: 'session', scheme: 'claude', sessionId: 'abc123', messageUuid: 'm1' },
    { kind: 'agent', name: 'perf' },
  ]);
});

const { THREAD_REF } = require('../out/refs.js');

test('thread refs: whole thread and single comment', () => {
  const text = 'relates to thread:th_8f2a1c-9 and specifically thread:th_8f2a1c-9#c_ab12cd, not xthread:th_1 or thread:foo';
  const matches = [...text.matchAll(THREAD_REF)].map((m) => ({ thread: m[1], comment: m[2] }));
  assert.deepEqual(matches, [
    { thread: 'th_8f2a1c-9', comment: undefined },
    { thread: 'th_8f2a1c-9', comment: 'c_ab12cd' },
  ]);
});
