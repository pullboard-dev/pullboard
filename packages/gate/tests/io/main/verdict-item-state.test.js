/** A gate verdict waiting on main ends in a withdrawn step when its item is no longer submitted at its candidate [SM16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import * as jobs from '../../../../jobs/index.js';
import { finishAwaitingVerdicts } from '../../../index.js';
import { recordGateVerdict } from '../../../index.js';
import { returnMainTest } from '../../../index.js';

const base = { commit: 'c'.repeat(40), tree: 't'.repeat(40), at: 10_000 };
const command = 'npm test --';
const file = 'test/a.test.js';
const reds = [{ file, name: 'case one' }];
const submitted = new Map();
const ports = { jobs, mainTestKind: 'main-test', queueMainTest: (db, at) => {
  const id = `main-test:${at.file}`;
  jobs.createJob(db, { id, kind: 'main-test', now: at.now });
  jobs.writeStep(db, id, 'queued', { tree: at.tree, file: at.file, command: at.command }, { now: at.now });
  return id;
}, itemSubmittedAt: (db, item, candidate) => submitted.get(item) === candidate };

test('gate.io-main-verdict-item-state.finishawaitingverdicts-ends-a-job-whose-item: clause 1: finishAwaitingVerdicts ends a job whose item is no longer submitted at its candidate with a withdrawn step and no verdict [SM16]', (t) => {
  const db = fixtureBoard(t).db;
  const candidate = 'a'.repeat(40);
  submitted.set(7, candidate);
  const gate = recordGateVerdict(ports, db, { item: 7, candidate, base, command, reds, now: 20_000 });
  assert.equal(gate.verdict, 'pending');
  submitted.set(7, 'e'.repeat(40));
  returnMainTest(jobs, db, gate.queued[0], { id: 'mr-1', tree: base.tree, file, command, verdict: 'red', failing: ['case one'], at: 21_000 }, { now: 21_000 });
  assert.deepEqual(finishAwaitingVerdicts(ports, db, { now: 22_000 }), [], 'a withdrawn verdict finishes nothing');
  const job = jobs.jobView(db, gate.id);
  assert.deepEqual(job.steps.map((step) => step.name), ['awaiting-main', 'withdrawn'], 'no verdict step is written');
  assert.equal(job.step, 'withdrawn');
  assert.deepEqual(finishAwaitingVerdicts(ports, db, { now: 23_000 }), [], 'a withdrawn verdict is not judged again');
});
