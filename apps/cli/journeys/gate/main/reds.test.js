/** Conveyor 1: a gate passes an item whose only reds are already red on main, using fresh main receipts [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../tests/fixtures/board.js';
import * as jobs from '../../../../../packages/jobs/index.js';
import {
  mainRedLookup,
  MAIN_TEST_JOB,
} from '../../../../../packages/drive/index.js';
import {
  recordGateVerdict,
  finishAwaitingVerdicts,
  returnMainTest,
  gateVerdictJobId,
  GATE_VERDICT_KIND,
} from '../../../../../packages/gate/index.js';


/** Hand the body a production-schema board in memory, closed when the case ends. */
function withBoard(t, body) {
  return body(fixtureBoard(t).db);
}

/** The ports a production caller passes: the jobs cell and the drive cell's main-test enqueue. */
const ports = { jobs, mainTestKind: MAIN_TEST_JOB, queueMainTest: (db, at) => mainRedLookup(db, [], at).job };

const base = { commit: 'c'.repeat(40), tree: 't'.repeat(40), at: 10_000 };
const command = 'npm test --';
const file = 'test/a.test.js';
const reds = [{ file, name: 'case one' }, { file, name: 'case two' }];

/** A main receipt for the red file at the gate base's tree. */
function receipt(fields = {}) {
  return { id: 'mr-1', tree: base.tree, file, command, verdict: 'red', failing: ['case one', 'case two', 'case three'], at: base.at + 5, ...fields };
}

/** Rows the board holds for builder facts and events: a gate that never bounces writes none. */
function builderRows(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
}

test('clause 1: every red named red by a fresh main receipt at the gate base records green with those cases listed as main-owned, no fact or resubmit [C7]', async t => {
  withBoard(t, (db) => {
    const gate = recordGateVerdict(ports, db, { item: 7, candidate: 'a'.repeat(40), base, command, reds, receipts: [receipt()], now: 20_000 });
    assert.equal(gate.verdict, 'green');
    assert.deepEqual(gate.queued, [], 'a fresh receipt queues no main-test job');
    const job = jobs.jobView(db, gateVerdictJobId(7, 'a'.repeat(40)));
    assert.equal(job.kind, GATE_VERDICT_KIND);
    assert.deepEqual(job.steps.map(step => step.name), ['verdict'], 'the gate records its verdict once and never waits or bounces');
    assert.deepEqual(job.steps[0].payload, { green: true, receipts: ['mr-1'],
      mainOwned: [{ file, name: 'case one', receipt: 'mr-1' }, { file, name: 'case two', receipt: 'mr-1' }] }, 'green with the main-owned cases and their receipt');
    assert.equal(jobs.jobsOf(db, { kind: MAIN_TEST_JOB }).length, 0);
    assert.equal(builderRows(db), 0, 'no builder fact or event is written: nothing asks for a resubmit');

    const stale = recordGateVerdict(ports, db, { item: 8, candidate: 'b'.repeat(40), base, command, reds, receipts: [receipt({ at: base.at - 1 })], now: 20_000 });
    assert.notEqual(stale.verdict, 'green', 'a receipt older than the base never excuses a red');
    const other = recordGateVerdict(ports, db, { item: 9, candidate: 'd'.repeat(40), base, command, reds, receipts: [receipt({ tree: 'e'.repeat(40) })], now: 20_000 });
    assert.notEqual(other.verdict, 'green', 'a receipt at another main tree never excuses a red');
    const own = recordGateVerdict(ports, db, { item: 10, candidate: 'f'.repeat(40), base, command, reds: [...reds, { file, name: 'case new' }], receipts: [receipt()], now: 20_000 });
    assert.equal(own.verdict, 'red', 'a case main does not name is the candidate\'s own');
    assert.deepEqual(own.own, [{ file, name: 'case new' }]);
    assert.equal(jobs.jobView(db, own.id).steps[0].payload.green, false);
  });
});

test('clause 2: a red file with no fresh main receipt queues a main-test job and the verdict finishes when it returns, without bouncing [C7]', async t => {
  withBoard(t, (db) => {
    const candidate = 'a'.repeat(40);
    const gate = recordGateVerdict(ports, db, { item: 7, candidate, base, command, reds, receipts: [receipt({ at: base.at - 1 })], now: 20_000 });
    assert.equal(gate.verdict, 'pending', 'no fresh receipt: the verdict waits, it is not red');
    assert.deepEqual(gate.missing, [file]);
    assert.equal(gate.queued.length, 1);
    const mainTest = jobs.jobView(db, gate.queued[0]);
    assert.equal(mainTest.kind, MAIN_TEST_JOB);
    assert.equal(mainTest.step, 'queued', 'the main-test job waits for a driver');
    assert.deepEqual(mainTest.steps[0].payload, { tree: base.tree, file, command });
    assert.equal(jobs.jobView(db, gate.id).step, 'awaiting-main');
    assert.deepEqual(finishAwaitingVerdicts(ports, db, { now: 21_000 }), [], 'nothing finishes before the main-test job returns');
    assert.equal(jobs.jobView(db, gate.id).step, 'awaiting-main');

    const again = recordGateVerdict(ports, db, { item: 7, candidate, base, command, reds, now: 21_500 });
    assert.deepEqual(again.queued, gate.queued, 'a second judge of the same gate reuses the one main-test job');
    assert.equal(jobs.jobsOf(db, { kind: MAIN_TEST_JOB }).length, 1);

    returnMainTest(jobs, db, gate.queued[0], receipt({ id: 'mr-2', at: 22_000 }), { now: 22_000 });
    const finished = finishAwaitingVerdicts(ports, db, { now: 23_000 });
    assert.deepEqual(finished.map(row => ({ id: row.id, verdict: row.verdict })), [{ id: gate.id, verdict: 'green' }]);
    const job = jobs.jobView(db, gate.id);
    assert.deepEqual(job.steps.map(step => step.name), ['awaiting-main', 'verdict'], 'waited on main, then recorded the verdict: no bounce step');
    assert.deepEqual(job.steps[1].payload.mainOwned, [{ file, name: 'case one', receipt: 'mr-2' }, { file, name: 'case two', receipt: 'mr-2' }]);
    assert.equal(job.steps[1].payload.green, true);
    assert.deepEqual(finishAwaitingVerdicts(ports, db, { now: 24_000 }), [], 'a finished verdict is not judged twice');
    assert.equal(builderRows(db), 0, 'the builder got no fact and no bounce');

    const greenMain = recordGateVerdict(ports, db, { item: 11, candidate: 'b'.repeat(40), base, command, reds: [{ file: 'test/b.test.js', name: 'case b' }], now: 25_000 });
    assert.equal(greenMain.verdict, 'pending');
    returnMainTest(jobs, db, greenMain.queued[0], { id: 'mr-3', tree: base.tree, file: 'test/b.test.js', command, verdict: 'green', failing: [], at: 26_000 }, { now: 26_000 });
    assert.deepEqual(finishAwaitingVerdicts(ports, db, { now: 27_000 }).map(row => ({ verdict: row.verdict, own: row.own })),
      [{ verdict: 'red', own: [{ file: 'test/b.test.js', name: 'case b' }] }], 'main green on the file: the returned verdict is the candidate\'s red');
  });
});
