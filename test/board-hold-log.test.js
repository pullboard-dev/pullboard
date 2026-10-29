/** @pullboard-test-input source-tree */
/** Real write-boundary observations and a deterministic source allowance, independent of fleet load [C7,P4]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { boardHoldBaselineProblems } from '../src/board-hold-ratchet.js';
import { committedBoardHoldBaselineProblems } from '../src/board-hold-ratchet.js';
import { boardHoldLines } from '../src/board-hold-log.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('one 1.2-second outer hold is logged with its command, seat and item, while 0.2 seconds is not [C7,P4]', () => {
  const box = helpers.project('true');
  box.env.PULLBOARD_MACHINE_HOME = join(box.dir, 'hold-observations');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const source = `
    import { openBoard, closeBoard, atomic } from ${JSON.stringify(new URL('../src/board.js', import.meta.url).href)};
    import assert from 'node:assert/strict';
    import { boardHoldStats } from ${JSON.stringify(new URL('../src/board-hold-log.js', import.meta.url).href)};
    assert.equal(boardHoldStats().available, false, 'a missing machine log is unmeasured, not healthy zero');
    assert.equal(boardHoldStats().count, null);
    // @pullboard-board-file locking: this real SQLite transaction measures the actual acquired/released boundary.
    const board = openBoard(process.argv[1], undefined, { writeContext: { command: 'fixture-hold', seat: 'web-1', item: 42 } });
    try {
      atomic(board, () => atomic(board, () => {
        // Wait is the subject: hold a real outer SQLite lock beyond the required one-second threshold.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
      }));
      board.writeContext.command = 'fixture-fast';
      atomic(board, () => {
        // The contrasting real hold stays below the threshold; no polling or product deadline is changed.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      });
    } finally { closeBoard(board); }
  `;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, file], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.context);
  const rows = readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'board-holds.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  const holds = rows.filter(row => row.command === 'fixture-hold');
  assert.equal(holds.length, 1, 'a nested savepoint never double-counts the same outer hold');
  assert.deepEqual([holds[0].seat, holds[0].item, holds[0].outcome], ['web-1', 42, 'committed']);
  assert.ok(holds[0].heldMs >= 1_200, 'the record measures the real held interval');
  assert.equal(rows.some(row => row.command === 'fixture-fast'), false);
  assert.deepEqual(Object.keys(holds[0]).sort(), ['at', 'command', 'heldMs', 'item', 'outcome', 'seat', 'version'],
    'no SQL, notes, CLI arguments, session ids or board data are published');
  appendFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'board-holds.jsonl'), 'null\n{}\n'
    + JSON.stringify({ version: 1, at: { toString: null }, heldMs: 1_200, command: 'invalid', seat: 'web-1' }) + '\n');
  const result = box.run(box.repo, 'stats', '--window', '24h', '--json');
  assert.equal(result.code, 0, result.err);
  const stats = JSON.parse(result.out).boardHolds;
  assert.equal(stats.invalidLines, 3, 'malformed diagnostic rows cannot crash a stats query or count as a hold');
  assert.equal(stats.commands.find(row => row.command === 'fixture-hold').count, 1);
  assert.equal(stats.commands.find(row => row.command === 'fixture-hold').slowestMs, holds[0].heldMs);
  const narrow = box.run(box.repo, 'stats', '--since', new Date(Date.now() + 60_000).toISOString(), '--json');
  assert.notEqual(narrow.code, 0, 'invalid future windows do not quietly report an invented zero');
  const shown = box.run(box.repo, 'stats', '--window', '24h');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /board write holds >1s:/u);
  assert.match(shown.out, /fixture-hold: 1 holds; slowest \d+ ms/u);
});

test('the daily allowance is unmeasured until its first full-day fact, and a measured baseline only falls [C7]', () => {
  const empty = { version: 1, allowancePerDay: null, observedDay: null, fact: null };
  const measured = { version: 1, allowancePerDay: 12, observedDay: '2026-10-28', fact: 'fixture-full-day-fact' };
  assert.deepEqual(boardHoldBaselineProblems(empty), []);
  assert.deepEqual(boardHoldBaselineProblems(measured, empty), []);
  assert.deepEqual(boardHoldBaselineProblems({ ...measured, allowancePerDay: 11 }, measured), []);
  assert.match(boardHoldBaselineProblems({ ...measured, allowancePerDay: 13 }, measured).join(), /only falls/u);
  assert.match(boardHoldBaselineProblems(empty, measured).join(), /cannot return to unmeasured/u);
  assert.match(boardHoldBaselineProblems({ ...measured, fact: null }, empty).join(), /day.*fact/u);
  assert.match(boardHoldBaselineProblems({ ...measured, observedDay: '2026-02-30' }, empty).join(), /day.*fact/u);
  const live = { available: true, count: 13, commands: [], truncated: false, invalidLines: 0,
    today: '2026-10-28', todayCount: 13 };
  assert.match(boardHoldLines(live, empty).join(), /WARNING: board hold allowance is unmeasured/u);
  assert.match(boardHoldLines(live, measured).join(), /WARNING: 13.*exceed the daily allowance 12/u);
});

test('the gate checks committed allowance changes without consulting live machine counts [C7]', () => {
  assert.deepEqual(committedBoardHoldBaselineProblems(join(import.meta.dirname, '..')), []);
  const box = helpers.project('true'), file = join(box.repo, 'src', 'board-hold-baseline.json');
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  const baseline = { version: 1, allowancePerDay: null, observedDay: null, fact: null };
  writeFileSync(file, JSON.stringify(baseline));
  box.git(box.repo, 'add', 'src/board-hold-baseline.json');
  box.git(box.repo, 'commit', '-qm', 'chore: initialize fixture allowance [G1]');
  const first = { version: 1, allowancePerDay: 12, observedDay: '2026-10-28', fact: 'fixture-full-day-fact' };
  writeFileSync(file, JSON.stringify(first));
  box.git(box.repo, 'commit', '-qam', 'chore: record fixture day [G1]');
  assert.deepEqual(committedBoardHoldBaselineProblems(box.repo), []);
  writeFileSync(file, JSON.stringify({ ...first, allowancePerDay: 13 }));
  box.git(box.repo, 'commit', '-qam', 'chore: raise fixture allowance [G1]');
  assert.match(committedBoardHoldBaselineProblems(box.repo).join(), /grew from 12 to 13/u,
    'a raised value stays refused even after it has been committed');
  writeFileSync(join(box.repo, 'unrelated.txt'), 'Unrelated fixture change.\n');
  box.git(box.repo, 'add', 'unrelated.txt');
  box.git(box.repo, 'commit', '-qm', 'chore: add unrelated fixture child [G1]');
  assert.match(committedBoardHoldBaselineProblems(box.repo).join(), /grew from 12 to 13/u,
    'an unrelated later commit cannot hide the committed allowance increase');
});
