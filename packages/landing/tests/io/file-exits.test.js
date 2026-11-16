/** @pullboard-test-input source-cell landing */
/** A landing shard prints each test file's exit code from its file-time record, so a census judges files whose case outcomes were voided [C7,#8303]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FILE_EXIT_LINE } from '../../src/io/shards.js';
import { FILE_TIME_LINE } from '../../src/io/shards.js';
import { shardFileLines } from '../../src/io/shards.js';

test('clause 1: a landing shard prints one exit line per test file, keeping the worst exit code when a file ran twice [C7]', () => {
  const record = [
    { file: 'apps/a.test.js', ms: 1200, code: 0 },
    { file: 'apps/b.test.js', ms: 900, code: 1 },
    { file: 'apps/c.test.js', ms: 300, code: 0 },
    { file: 'apps/c.test.js', ms: 400, code: 1 },
    { file: 'apps/d.test.js', ms: 50 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n{"file":"apps/e.test.js","ms":7';
  const lines = shardFileLines(record);
  const exits = lines.filter(line => line.startsWith(FILE_EXIT_LINE)).sort();
  assert.deepEqual(exits, [`${FILE_EXIT_LINE}0 apps/a.test.js`, `${FILE_EXIT_LINE}1 apps/b.test.js`, `${FILE_EXIT_LINE}1 apps/c.test.js`],
    'one exit line per file that recorded a code; a rerun that failed wins, an old record without a code and a torn line print none');
  assert.equal(lines.filter(line => line.startsWith(FILE_TIME_LINE)).length, 4, 'every timed file still prints its wall time');
  assert.ok(lines.includes(`${FILE_TIME_LINE}400 apps/c.test.js`), 'the longest time still stands');
});
