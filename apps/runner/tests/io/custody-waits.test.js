/** @pullboard-test-input source-cell apps/runner */
/** @pullboard-world-pin reads the custody and worker process sources to prove each polling wait carries a budget line [C7,#9525]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '../../../..');
const FILES = ['apps/runner/src/io/custody.js', 'apps/runner/src/io/worker/process.js'];
const BUDGET = /\/\/\s*budget:/u;
const TIMEOUT_WAIT = /setTimeout\(\w+,\s*[\d_]+\)/u;

/** The lines of a file that await a timeout wait, with the line above each one, so a budget comment on either counts. */
function timerLines(path) {
  const lines = readFileSync(join(ROOT, path), 'utf8').split('\n');
  return lines.map((text, index) => ({ path, text, number: index + 1, above: lines[index - 1] ?? '' }))
    .filter(({ text }) => !/^\s*(?:\/\/|\*|\/\*)/u.test(text) && TIMEOUT_WAIT.test(text));
}

test('clause 1: the 6 custody sleeps and the process-group retry and signal waits each carry a // budget: line [C7,#9525]', () => {
  const custody = timerLines(FILES[0]);
  const worker = timerLines(FILES[1]);
  assert.equal(custody.length, 6, 'custody.js holds six timer waits');
  assert.equal(worker.length, 4, 'worker/process.js holds the retry wait and three nested signal waits');
  for (const row of [...custody, ...worker]) assert.match(`${row.above}\n${row.text}`, BUDGET, `${row.path}:${row.number} carries a budget line`);
});

test('clause 2: neither file holds a poll the timer lint would count, only annotated sites [C7,#9525]', () => {
  const open = FILES.flatMap(timerLines).filter(({ text, above }) => !BUDGET.test(text) && !BUDGET.test(above)).map(({ path, number }) => `${path}:${number}`);
  assert.deepEqual(open, []);
});
