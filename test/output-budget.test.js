/** Every command's default text fits a declared budget, and a ratchet keeps measured sizes from growing [C7,N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { DEFAULT_OUTPUT_BUDGET, LINE_BUDGET, commandName, cutLine, outputBudget } from '../src/json-output.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** The commands measured on the seeded board, with the arguments a reader passes them by default. */
const MEASURED = [['status'], ['list', 'web'], ['show', '1'], ['queue'], ['roadmap'], ['log'], ['stats'], ['lanes'],
  ['agents'], ['whoami'], ['decisions'], ['flakes'], ['spec'], ['doctrine'], ['ledger'], ['health'], ['capacity']];

/** Committed sizes in UTF-8 bytes; an entry may only fall. */
const BASELINE = JSON.parse(readFileSync(new URL('./output-budget-baseline.json', import.meta.url), 'utf8'));

/** Name every command whose measured default text is over its committed baseline or its declared budget. */
function ratchetProblems(measured, baseline) {
  const problems = [];
  for (const [command, bytes] of Object.entries(measured)) {
    if (!Object.hasOwn(baseline, command)) problems.push(`${command}: ${bytes} bytes and no committed baseline`);
    else if (bytes > baseline[command]) problems.push(`${command}: ${bytes} bytes, over its baseline of ${baseline[command]}`);
    if (bytes > outputBudget(command)) problems.push(`${command}: ${bytes} bytes, over its declared budget of ${outputBudget(command)}`);
  }
  return problems;
}

/** A real project whose board holds hundreds of long items and shouts, so unbounded reads would overflow. */
function seeded() {
  const box = helpers.project('true');
  // @pullboard-board-file journey: the real CLI subprocesses read this seeded project board.
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    for (let index = 0; index < 300; index += 1) {
      store.addItem(board, { by: 'coordinator', lane: 'web', title: `Seeded budget item ${index} ${'with a long readable title '.repeat(3)}`,
        criterion: 'The seeded behaviour is observable.', specIds: ['G1'] });
    }
    for (let index = 0; index < 200; index += 1) store.shout(board, { from: 'coordinator', to: 'web-1', text: `Seeded note ${index} ${'x'.repeat(120)}`, lanes: ['web'] });
  } finally { store.closeBoard(board); }
  return box;
}

test('every measured command prints within its committed baseline and declared budget on a seeded board [C7,N26]', () => {
  const box = seeded();
  const measured = {};
  for (const args of MEASURED) {
    const result = box.run(box.repo, ...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}`);
    measured[args[0]] = Buffer.byteLength(result.out);
  }
  assert.deepEqual(ratchetProblems(measured, BASELINE), [], JSON.stringify(measured));
  const full = box.run(box.repo, 'list', 'web', '--detail');
  assert.ok(Buffer.byteLength(full.out) > DEFAULT_OUTPUT_BUDGET, '--detail still prints every row');
  const bounded = box.run(box.repo, 'list', 'web');
  assert.match(bounded.out, /more lines withheld to keep this output within 8192 bytes; add --detail for all of it, or --json/u);
  assert.equal(JSON.parse(box.run(box.repo, 'list', 'web', '--json').out).items.length, 300, '--json is never trimmed by the text budget');
});

test('a command over its baseline or its budget fails the ratchet naming it [C7]', () => {
  assert.deepEqual(ratchetProblems({ list: 5000 }, { list: 4000 }), ['list: 5000 bytes, over its baseline of 4000']);
  assert.deepEqual(ratchetProblems({ queue: 9000 }, { queue: 9000 }), ['queue: 9000 bytes, over its declared budget of 8192']);
  assert.deepEqual(ratchetProblems({ newcomer: 10 }, {}), ['newcomer: 10 bytes and no committed baseline']);
  for (const [command, bytes] of Object.entries(BASELINE)) assert.ok(bytes <= outputBudget(command), `${command}'s baseline is within its budget`);
});

test('streams and reference pages are declared unbounded, and a single long line is cut with a pointer [C7]', () => {
  for (const command of ['view', 'watch', 'help']) assert.equal(outputBudget(command), Infinity);
  assert.equal(outputBudget('list'), DEFAULT_OUTPUT_BUDGET);
  assert.equal(commandName(['--json', 'stats', '--window', '24h']), 'stats');
  const cut = cutLine('agents: ' + 'a'.repeat(5000));
  assert.ok(Buffer.byteLength(cut) <= LINE_BUDGET);
  assert.match(cut, /--detail shows the whole line$/u);
  assert.equal(cutLine('short'), 'short');
});
