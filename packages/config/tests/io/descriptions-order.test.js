/** @pullboard-test-input source-cell config */
/** @pullboard-world-pin reads the committed descriptions source to prove its rows are sorted and unchanged in text. */
/** The setting description rows sit in sorted key order inside each group, so two items adding settings do not conflict [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const FILE = new URL('../../src/io/settings/descriptions.js', import.meta.url);
const BEFORE = JSON.parse(readFileSync(new URL('../fixtures/descriptions-row-hashes.json', import.meta.url), 'utf8'));
const keyOf = (line) => /^ {2}\['((?:[^'\\]|\\.)*)'/u.exec(line)?.[1];

/** The ROWS lines of descriptions.js. */
function rowLines() {
  const lines = readFileSync(FILE, 'utf8').split('\n');
  const start = lines.indexOf('const ROWS = [');
  const end = lines.indexOf('];', start);
  return lines.slice(start + 1, end);
}

test('clause 1: description rows are one per line and in sorted key order inside each comment-headed group [C7]', () => {
  let group = [];
  const check = () => {
    const keys = group.map(keyOf);
    assert.deepEqual(keys, [...keys].sort(), 'rows out of order; next: sort the rows of that group by key');
    group = [];
  };
  for (const line of rowLines()) {
    if (line.startsWith('  //')) check();
    else {
      assert.ok(keyOf(line) && line.endsWith('],'), `not one row on one line: ${line.slice(0, 80)}`);
      group.push(line);
    }
  }
  check();
});

test('clause 2: every key described before the sort is still described with the same text [C7]', () => {
  const now = new Map(rowLines().filter((line) => !line.startsWith('  //')).map((line) => [keyOf(line), line]));
  BEFORE.keys.forEach((key, i) => {
    const hash = BEFORE.hashes[i];
    assert.ok(now.has(key), `${key} lost its description`);
    assert.equal(createHash('sha1').update(now.get(key)).digest('hex'), hash, `${key} text changed`);
  });
});
