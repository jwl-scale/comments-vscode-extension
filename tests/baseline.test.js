const { test } = require('node:test');
const assert = require('node:assert');

const { gitBlobSha, lineMap, translateAnchor } = require('../out/baseline.js');

test('gitBlobSha matches git hash-object', () => {
  // $ printf 'hello\n' | git hash-object --stdin
  assert.equal(gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  // $ printf '' | git hash-object --stdin
  assert.equal(gitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

const anchor = (startLine, endLine, text) => ({
  baseline: null,
  start: { line: startLine, char: 2 },
  end: { line: endLine, char: 5 },
  text,
  prefix: '',
  suffix: '',
});

test('translateAnchor: insertion above shifts, edit below leaves alone', () => {
  const base = ['a', 'b', 'target', 'd', 'e'].join('\n');
  const above = ['a', 'NEW', 'b', 'target', 'd', 'e'].join('\n');
  const below = ['a', 'b', 'target', 'd', 'CHANGED'].join('\n');

  const shifted = translateAnchor(base, above, anchor(2, 2, 'target'));
  assert.deepEqual(shifted, { start: { line: 3, char: 2 }, end: { line: 3, char: 5 }, exact: true });

  const same = translateAnchor(base, below, anchor(2, 2, 'target'));
  assert.deepEqual(same.start, { line: 2, char: 2 });
});

test('translateAnchor: modifying the anchored line itself returns null (honest ambiguity)', () => {
  const base = ['a', 'b', 'target', 'd'].join('\n');
  const cur = ['a', 'b', 'target CHANGED', 'd'].join('\n');
  assert.equal(translateAnchor(base, cur, anchor(2, 2, 'target')), null);
});

test('translateAnchor: multi-line anchor must survive contiguously', () => {
  const base = ['a', 'x1', 'x2', 'x3', 'b'].join('\n');
  const intact = ['NEW', 'a', 'x1', 'x2', 'x3', 'b'].join('\n');
  const split = ['a', 'x1', 'INSERTED', 'x2', 'x3', 'b'].join('\n');

  const moved = translateAnchor(base, intact, anchor(1, 3, 'x1\nx2\nx3'));
  assert.deepEqual([moved.start.line, moved.end.line], [2, 4]);

  assert.equal(translateAnchor(base, split, anchor(1, 3, 'x1\nx2\nx3')), null);
});

test('translateAnchor: multiple hunks on both sides translate exactly', () => {
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const lines = base.split('\n');
  lines.splice(35, 1, 'line 35 EDITED'); // hunk below
  lines.splice(20, 0, 'inserted A', 'inserted B'); // hunk above (2 lines)
  lines.splice(5, 2); // deletion above (-2 lines)
  const cur = lines.join('\n');
  const t = translateAnchor(base, cur, anchor(25, 26, 'line 25\nline 26'));
  assert.deepEqual([t.start.line, t.end.line], [25, 26]); // -2 +2 = net zero shift
});

test('lineMap: identical content maps identity', () => {
  const text = 'a\nb\nc';
  const map = lineMap(text, text);
  assert.deepEqual([...map], [0, 1, 2]);
});
