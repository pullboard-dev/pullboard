/** Every command's default text fits a declared budget [C7,N26]; the growth ratchet against main is growth.test.js. */
/** @pullboard-world-pin: clause 2 asserts the committed byte baseline file is absent from the repository. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { createBudgetMeasure } from '../../tests/fixtures/budget-measure.js';
import {
  DEFAULT_OUTPUT_BUDGET,
  LINE_BUDGET,
  commandName,
  commandOutput,
  cutLine,
  outputBudget,
} from '../../../../packages/config/index.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const { outputBudgetProject, measure, ratchetProblems, seeded } = createBudgetMeasure(helpers);

test('clause 1: every measured command prints within its declared budget on a seeded board [C7,N26]', async () => {
  const box = seeded();
  const headSizes = await measure(box, helpers.BIN);
  assert.deepEqual(ratchetProblems(headSizes, {}), [], JSON.stringify(headSizes));
  const full = await box.runLocal(box.repo, 'list', 'web', '--detail');
  assert.ok(Buffer.byteLength(full.out) > DEFAULT_OUTPUT_BUDGET, '--detail still prints every row');
  const bounded = await box.runLocal(box.repo, 'list', 'web');
  assert.match(bounded.out, /more lines withheld to keep this output within 8192 bytes; add --detail for all of it, or --json/u);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'list', 'web', '--json')).out).items.length, 300, '--json is never trimmed by the text budget');
});

test('a long withheld next step is cut to one line and the whole output stays within the budget [C7,N26]', () => {
  let printed = '';
  const io = commandOutput(['blueprint'], { stdout: { write: text => { printed += text; } }, stderr: { write() {} } }, { refusalDocument: () => ({}) });
  for (let index = 0; index < 200; index += 1) io.say(`draft row ${index} ${'x'.repeat(80)}`);
  io.say('next: ' + Array.from({ length: 130 }, (_, index) => `src/very/long/path/file-${index}.js`).join(' '));
  io.flush(0);
  assert.ok(Buffer.byteLength(printed) <= DEFAULT_OUTPUT_BUDGET, `${Buffer.byteLength(printed)} bytes`);
  const lines = printed.trimEnd().split('\n');
  assert.match(lines.at(-1), /^next: src\/very\/long\/path\/file-0\.js .*--detail shows the whole line\)$/u, 'the next step survives, cut to one line');
  assert.match(lines.at(-2), /more lines withheld/u);
});

test('a command over its baseline or its budget fails the ratchet naming it [C7]', () => {
  assert.deepEqual(ratchetProblems({ list: 5000 }, { list: 4000 }), ['list: 5000 bytes, over its main size of 4000']);
  assert.deepEqual(ratchetProblems({ queue: 9000 }, { queue: 9000 }), ['queue: 9000 bytes, over its declared budget of 8192']);
  assert.deepEqual(ratchetProblems({ newcomer: 10 }, {}), [], 'a command main lacks passes the growth check');
});

test('clause 2: the committed byte baseline is deleted and nothing reads it [C7]', () => {
  assert.equal(existsSync(new URL('./output-budget-' + 'baseline.json', import.meta.url)), false, 'the JSON baseline is gone');
});

test('streams and reference pages are declared unbounded, and a single long line is cut with a pointer [C7]', () => {
  for (const command of ['view', 'watch', 'help']) assert.equal(outputBudget(command), Infinity);
  assert.equal(outputBudget('list'), DEFAULT_OUTPUT_BUDGET);
  assert.equal(commandName(['--json', 'stats', '--window', '24h']), 'stats');
  const cut = cutLine('agents: ' + 'a'.repeat(5000));
  assert.ok(Buffer.byteLength(cut) <= LINE_BUDGET);
  assert.match(cut, /--detail shows the whole line\)$/u);
  assert.equal(cutLine('short'), 'short');
});

test('inbox after a read shows nothing old: a delivered interrupt comes back only as its id [N26,R2]', async () => {
  const box = outputBudgetProject();
  // A seat's first read starts at the board head [C7,#6152], so this seat reads once before the decision is answered.
  assert.equal((await box.runLocal(box.web, 'inbox')).code, 0);
  // @pullboard-board-file journey: the real CLI subprocesses read this answered decision as an interrupt.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const question = store.shout(board, { from: 'web-1', to: 'coordinator', text: 'Which path?', decision: true, lanes: ['web'] });
    store.answerDecision(board, question, { agentId: 'coordinator', text: 'Use the reviewed path', lanes: ['web'] });
  } finally { store.closeBoard(board); }
  const first = await box.runLocal(box.web, 'inbox');
  assert.match(first.out, /Use the reviewed path/u, 'the first read delivers the answer');
  const second = await box.runLocal(box.web, 'inbox');
  assert.doesNotMatch(second.out, /Use the reviewed path|Which path\?/u, 'the second read replays nothing old');
  assert.match(second.out, /1 delivered interrupt still unacted: event:\d+; clear with pullboard inbox --acted-on <ids>/u);
  const id = JSON.parse((await box.runLocal(box.web, 'inbox', '--json')).out).activity.pending[0];
  assert.equal((await box.runLocal(box.web, 'inbox', '--acted-on', id)).code, 0);
  assert.match((await box.runLocal(box.web, 'inbox')).out, /no new shouts or activity/u, 'acting on it clears the reminder');
});
