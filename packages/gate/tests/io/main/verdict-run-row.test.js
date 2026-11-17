/** With runs_store on, a gate verdict waiting on main is a run row in state awaiting with its record; off, it stays a job step [B2,M3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import * as jobs from '../../../../jobs/index.js';
import { awaitingVerdictRuns } from '../../../../store/index.js';
import { writeVerdictRun } from '../../../../store/index.js';
import { finishAwaitingVerdicts } from '../../../index.js';
import { recordGateVerdict } from '../../../index.js';
import { returnMainTest } from '../../../index.js';

const base = { commit: 'c'.repeat(40), tree: 't'.repeat(40), at: 10_000 };
const command = 'npm test --';
const file = 'test/a.test.js';
const reds = [{ file, name: 'case one' }];
const candidate = 'a'.repeat(40);
const queueMainTest = (db, at) => {
  const id = `main-test:${at.file}`;
  jobs.createJob(db, { id, kind: 'main-test', now: at.now });
  jobs.writeStep(db, id, 'queued', { tree: at.tree, file: at.file, command: at.command }, { now: at.now });
  return id;
};
const off = { jobs, mainTestKind: 'main-test', queueMainTest };
const on = { ...off, verdictRun: { write: writeVerdictRun, awaiting: awaitingVerdictRuns } };
const runRow = (db, id) => db.prepare('SELECT * FROM run WHERE run_job = ?').get(id);

test('clause 1: with runs_store on, a gate verdict waiting for main is a run row in state awaiting that carries the verdict record [B2,M3]', (t) => {
  const db = fixtureBoard(t).db;
  const gate = recordGateVerdict(on, db, { item: 7, candidate, base, command, reds, now: 20_000 });
  assert.equal(gate.verdict, 'pending');
  const row = runRow(db, gate.id);
  assert.equal(row.run_state, 'awaiting');
  assert.equal(row.run_kind, 'gate-verdict');
  assert.equal(row.run_item, 7);
  assert.deepEqual(JSON.parse(row.run_record), { base, command, reds, missing: [file], queued: gate.queued });
  assert.equal(jobs.jobView(db, gate.id), null, 'no job row is written for the verdict');
  returnMainTest(jobs, db, gate.queued[0], { id: 'mr-1', tree: base.tree, file, command, verdict: 'red', failing: ['case one'], at: 21_000 }, { now: 21_000 });
  const finished = finishAwaitingVerdicts(on, db, { now: 22_000 });
  assert.deepEqual(finished.map(row2 => row2.verdict), ['green'], 'main-owned reds finish the waiting verdict');
  const settled = runRow(db, gate.id);
  assert.equal(settled.run_state, 'done');
  assert.equal(settled.run_outcome, 'green');
});

test('clause 2: with runs_store off, the verdict is kept where it is today [B2,M3]', (t) => {
  const db = fixtureBoard(t).db;
  const gate = recordGateVerdict(off, db, { item: 7, candidate, base, command, reds, now: 20_000 });
  assert.equal(runRow(db, gate.id), undefined, 'no run row while the flag is off');
  assert.equal(jobs.jobView(db, gate.id).step, 'awaiting-main', 'the wait is a job step as before');
});
