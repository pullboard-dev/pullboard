/** @pullboard-test-input source-cell packages/gate */
/** @pullboard-world-pin reads the pool and run-tests sources and the timers ceiling file to prove the waits carry budget lines [C7,#9522]. */
/** The test-file pool's POLL_MS waits and the run-tests ack interval carry a budget line, and the timers ceiling holds no poll for them [C7,#9522]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { timerUses } from '../../../../src/io/adapter-lints/timers.js';

const ROOT = join(import.meta.dirname, '../../../../../..');
const POOL = 'packages/gate/src/io/test/file/pool.js';
const RUN_TESTS = 'packages/gate/src/io/run-tests.js';
const CEILINGS = 'packages/gate/data/ceilings/adapter-lint-timers.json';

/** A repo file's lines. */
const lines = path => readFileSync(join(ROOT, path), 'utf8').split('\n');

test('clause 1: every POLL_MS wait in pool.js and the 25 ms pollAcks interval in run-tests.js carry a // budget: line [C7,#9522]', () => {
  const waits = lines(POOL).map((text, index) => ({ text, index })).filter(({ text }) => /(?:setTimeout\([^)]*POLL_MS\)|pauseSync\(POLL_MS\))/u.test(text));
  assert.ok(waits.length >= 7, 'the scan finds the pool waits');
  for (const { text, index } of waits) assert.match(`${lines(POOL)[index - 1] ?? ''}\n${text}`, /\/\/\s*budget:/u, `${POOL}:${index + 1} carries a budget line`);
  const intervals = lines(RUN_TESTS).map((text, index) => ({ text, index })).filter(({ text }) => /setInterval\(pollAcks, 25\)/u.test(text));
  assert.equal(intervals.length, 2);
  for (const { text, index } of intervals) assert.match(`${lines(RUN_TESTS)[index - 1] ?? ''}\n${text}`, /\/\/\s*budget:/u, `${RUN_TESTS}:${index + 1} carries a budget line`);
});

test('clause 2: the timer lint counts no poll in pool.js or run-tests.js, and the ceiling file holds none for them and sums to its total [C7,#9522]', () => {
  for (const path of [POOL, RUN_TESTS]) assert.deepEqual(timerUses(lines(path).join('\n')).filter(row => row.kind === 'poll'), [], `${path} has no unannotated poll`);
  const ceiling = JSON.parse(readFileSync(join(ROOT, CEILINGS), 'utf8'));
  assert.equal(ceiling.files[POOL]?.poll ?? 0, 0);
  assert.equal(ceiling.files[RUN_TESTS]?.poll ?? 0, 0);
  const sum = Object.values(ceiling.files).reduce((all, kinds) => all + Object.values(kinds).reduce((one, count) => one + count, 0), 0);
  assert.equal(ceiling.total, sum);
});
