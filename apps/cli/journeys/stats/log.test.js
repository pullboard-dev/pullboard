/** @pullboard-test-input apps/lib/index.js packages/store/index.js packages/store/src/io/board/hold/baseline.json packages/store/src/io/board/write/lock.js */
/** Real write-boundary observations and a deterministic source allowance, independent of fleet load [C7,P4]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { boardHoldBaselineProblems } from '../../../../packages/store/index.js';
import { committedBoardHoldBaselineProblems } from '../../../../packages/store/index.js';
import { boardHoldLines } from '../../../../packages/store/index.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js'; // the two inline-script children below stay processes: they hold a real SQLite writer in a separate process

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-stats-log.one-1-2-second-outer-hold: one 1.2-second outer hold is logged with its command, seat and item, while 0.2 seconds is not [C7,P4]', async () => {
  const box = helpers.project('true');
  box.env.PULLBOARD_MACHINE_HOME = join(box.dir, 'hold-observations');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const source = `
    import { closeBoard, atomic } from ${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)};
    import { openBoard } from ${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)};
    import assert from 'node:assert/strict';
    import { boardHoldStats } from ${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)};
    import { measureBoardWritePhase } from ${JSON.stringify(new URL('../../../../packages/store/src/io/board/write/lock.js', import.meta.url).href)};
    assert.equal(boardHoldStats().available, false, 'a missing machine log is unmeasured, not healthy zero');
    assert.equal(boardHoldStats().count, null);
    // @pullboard-board-file locking: this real SQLite transaction measures the actual acquired/released boundary.
    const board = openBoard(process.argv[1], undefined, { writeContext: { command: 'fixture-hold', seat: 'web-1', item: 42 } });
    try {
      atomic(board, () => measureBoardWritePhase(board.db, 'fixture-move', () => atomic(board, () => {
        // Wait is the subject: hold a real outer SQLite lock beyond the required one-second threshold.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
      })));
      board.writeContext.command = 'fixture-fast';
      atomic(board, () => {
        // The contrasting real hold stays below the threshold; no polling or product deadline is changed.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      });
      board.writeContext.command = 'fixture-policy';
      let attempts = 0;
      board.prepareWritePolicy = () => ({
        current() {
          if (attempts++ > 0) return true;
          // Exercise a slow policy admission after BEGIN, including the rolled-back retry.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
          return false;
        },
        enter() {}, leave() {}, assertCurrent() {},
      });
      atomic(board, () => {});
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
  assert.equal(holds[0].phase, 'fixture-move');
  assert.ok(holds[0].phaseMs >= 1_200);
  assert.ok(holds[0].heldMs >= 1_200, 'the record measures the real held interval');
  assert.equal(rows.some(row => row.command === 'fixture-fast'), false);
  const admission = rows.filter(row => row.command === 'fixture-policy');
  assert.equal(admission.length, 1, 'a rejected slow admission is recorded even when a retry succeeds');
  assert.equal(admission[0].outcome, 'rolled-back');
  assert.equal(admission[0].phase, 'policy-admission');
  assert.ok(admission[0].heldMs >= 1_200);
  assert.deepEqual(Object.keys(holds[0]).sort(), ['at', 'boardFile', 'command', 'heldMs', 'item', 'move', 'outcome', 'phase', 'phaseMs', 'seat', 'step', 'stepMs', 'version'],
    'no SQL, notes, CLI arguments, session ids or board data are published; the board file path is the one added key [C7]');
  appendFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'board-holds.jsonl'), 'null\n{}\n'
    + JSON.stringify({ version: 1, at: { toString: null }, heldMs: 1_200, command: 'invalid', seat: 'web-1' }) + '\n');
  for (const heldMs of [1_100, 1_700, 2_300, 3_100]) appendFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'board-holds.jsonl'), JSON.stringify({ ...holds[0], command: 'sample', heldMs }) + '\n');
  const result = await box.runLocal(box.repo, 'stats', '--window', '24h', '--json');
  assert.equal(result.code, 0, result.err);
  const stats = JSON.parse(result.out).boardHolds;
  assert.equal(stats.invalidLines, 3, 'malformed diagnostic rows cannot crash a stats query or count as a hold');
  assert.deepEqual(stats.commands.find(row => row.command === 'sample'), { command: 'sample', count: 4, totalMs: 8_200, slowestMs: 3_100, p50Ms: 2_000 });
  assert.equal(stats.commands.find(row => row.command === 'fixture-hold').count, 1);
  assert.equal(stats.commands.find(row => row.command === 'fixture-hold').slowestMs, holds[0].heldMs);
  assert.equal(stats.commands.find(row => row.command === 'fixture-hold').totalMs, holds[0].heldMs);
  assert.equal(stats.commands.find(row => row.command === 'fixture-hold').p50Ms, holds[0].heldMs);
  // Process-level case: an unrefused throw from a future window must end a real CLI with a nonzero exit; in process it would propagate to the test.
  const narrow = box.run(box.repo, 'stats', '--since', new Date(Date.now() + 60_000).toISOString(), '--json');
  assert.notEqual(narrow.code, 0, 'invalid future windows do not quietly report an invented zero');
  const shown = await box.runLocal(box.repo, 'stats', '--window', '24h');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /board write holds >1s:/u);
  assert.match(shown.out, /fixture-hold: 1 holds; total \d+ ms; p50 \d+ ms; max \d+ ms/u);
});

test('cli.journeys-stats-log.a-hold-log-append-observes-the: a hold log append observes the actual SQLite writer already released after commit and rollback [B2,C7,P4]', t => {
  const box = cellProject(t);
  box.env.PULLBOARD_MACHINE_HOME = join(box.dir, 'post-release-observations');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { DatabaseSync } from 'node:sqlite';
    import { closeBoard, atomic } from ${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)};
    import { openBoard } from ${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)};
    import { boardHoldLog } from ${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)};
    // @pullboard-board-file locking: a separate real connection probes the same writer at the actual append.
    const board = openBoard(process.argv[1], undefined, { writeContext: { command: 'post-commit', seat: 'web-1', item: 42 } });
    const peer = new DatabaseSync(process.argv[1]);
    peer.exec('PRAGMA busy_timeout=0');
    const original = { openSync: fs.openSync, writeSync: fs.writeSync, closeSync: fs.closeSync };
    const logFds = new Set(), observations = [];
    /** Probe the real lock, releasing the peer's own transaction whenever acquisition succeeds. */
    function writerAvailable() {
      try { peer.exec('BEGIN IMMEDIATE'); }
      catch (error) { assert.match(error.message, /locked/u); return false; }
      peer.exec('ROLLBACK');
      return true;
    }
    /** Track only the real diagnostic descriptor while preserving every filesystem operation. */
    fs.openSync = (...args) => {
      const fd = original.openSync(...args);
      if (args[0] === boardHoldLog()) logFds.add(fd);
      return fd;
    };
    /** Observe SQLite immediately before the real append; retain errors outside optional logging's catch. */
    fs.writeSync = (...args) => {
      if (logFds.has(args[0])) {
        try { observations.push(writerAvailable()); }
        catch (error) { observations.push(error.message); }
      }
      return original.writeSync(...args);
    };
    /** Never mistake a later reuse of a closed descriptor for the diagnostic log. */
    fs.closeSync = fd => { logFds.delete(fd); return original.closeSync(fd); };
    syncBuiltinESMExports();
    try {
      for (const outcome of ['commit', 'rollback']) {
        board.writeContext.command = 'post-' + outcome;
        const refusal = new Error('deliberate rollback');
        /** The wait is the subject: one actual outer hold must cross the logging threshold. */
        const held = () => {
          assert.equal(writerAvailable(), false, 'the separate connection is blocked while work owns the writer');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
          if (outcome === 'rollback') throw refusal;
        };
        if (outcome === 'commit') atomic(board, held);
        else assert.throws(() => atomic(board, held), error => error === refusal);
      }
      assert.deepEqual(observations, [true, true], 'both actual log appends happen after SQLite releases the writer');
      const rows = fs.readFileSync(boardHoldLog(), 'utf8').trim().split('\\n').map(line => JSON.parse(line))
        .filter(row => row.command === 'post-commit' || row.command === 'post-rollback');
      assert.deepEqual(rows.map(row => row.outcome), ['committed', 'rolled-back']);
    } finally {
      Object.assign(fs, original); syncBuiltinESMExports();
      closeBoard(board); peer.close();
    }
  `;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, file], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.context);
});

test('cli.journeys-stats-log.the-daily-allowance-is-unmeasured-until: the daily allowance is unmeasured until its first full-day fact, and a measured baseline only falls [C7]', () => {
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

test('cli.journeys-stats-log.the-gate-checks-committed-allowance-changes: the gate checks committed allowance changes without consulting live machine counts [C7]', t => {
  assert.deepEqual(committedBoardHoldBaselineProblems(join(import.meta.dirname, '../../../..')), []);
  const box = cellProject(t), file = join(box.repo, 'packages/store/src/io/board/hold/baseline.json');
  mkdirSync(join(box.repo, 'packages/store/src/io/board/hold'), { recursive: true });
  const baseline = { version: 1, allowancePerDay: null, observedDay: null, fact: null };
  writeFileSync(file, JSON.stringify(baseline));
  box.git(box.repo, 'add', 'packages/store/src/io/board/hold/baseline.json');
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
