/** A new head replaces the item's queued or running gate: the old gate stops and frees its slot, the new one queues [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { driverRecord } from '../../tests/fixtures/gate/driver.js';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { gateSettled } from '../../tests/fixtures/submit/handoff.js';
import { removeSandboxes } from '../../tests/fixtures/submit/handoff.js';
import { openBoard } from '../../../lib/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { submitHandoff } from '../../../../packages/store/index.js';
import { stopReplacedWorker } from '../../index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Require authentic command success before interpreting any native result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read the real SQLite state the separate worker wrote, without writing anything. */
function state(box, id) {
  // @pullboard-board-file journey: observe the detached worker's actual persisted queue record.
  const board = openBoard(box.boardFile);
  try { return { item: getItem(board, id), job: submitHandoff(board, id) }; }
  finally { board.db.close(); }
}

/** Quote a private fixture path for the configured shell command. */
function word(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Whether a process is gone; any other signal error leaves it presumed alive. */
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** A native project with handoff on and a gate that holds while the candidate says "hold", until released. */
function fixture(t) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  const release = join(box.dir, 'release'), started = join(box.dir, 'started');
  const script = join(box.dir, 'gate.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    "const value = fs.existsSync('web/snapshot.txt') ? fs.readFileSync('web/snapshot.txt', 'utf8').trim() : 'base';",
    "if (value === 'hold') {",
    ` fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));`,
    ' const deadline = Date.now() + 120000;',
    ` while (!fs.existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) throw Error('fixture release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
    '}',
  ].join('\n'));
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Replaced running handoff', '--specs', 'G1',
    '--criterion', 'A new head replaces a running gate.', '--check', `${word(process.execPath)} ${word(script)}`, '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  t.after(async () => {
    writeFileSync(release, 'release\n');
    await helpers.waitFor(() => !['queued', 'running'].includes(state(box, id).job?.state), 'queued worker finished', 120000); // budget: cleanup ceiling, no timing assertion.
    // The driver and dispatcher still write for a moment after the job ends; remove the tree only once they are done.
    await gateSettled(helpers, box, state(box, id).job?.id);
    await removeSandboxes(helpers);
  });
  return { ...box, helpers, id, started };
}

test('submitting head B while head A gates cancels A, frees its slot and queues B [C7,V4]', async t => {
  const box = fixture(t);
  assert.equal(box.helpers.commitFile(box, box.web, 'web/snapshot.txt', 'hold\n', 'feat(web): held candidate [G1]').status, 0);
  assert.equal(document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json')).queued, true);
  await box.helpers.waitFor(() => existsSync(box.started) && state(box, box.id).job?.state === 'running', 'the gate is running', 120000); // budget: real worker start ceiling, no timing assertion.
  const first = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', first.id);
  const owner = driverRecord(box.boardFile, first.id);

  assert.equal(box.helpers.commitFile(box, box.web, 'web/snapshot.txt', 'pass\n', 'feat(web): next candidate [G1]').status, 0);
  const next = box.run(box.web, 'submit', String(box.id), '--no-next', '--json');
  assert.doesNotMatch(next.out + next.err, /SUBMIT_HANDOFF_PENDING/u, 'a new head is never refused behind the old gate');
  assert.equal(document(next).queued, true, 'head B queued its own gate');
  const after = state(box, box.id);
  assert.notEqual(after.job.id, first.id, 'B has its own job');
  assert.equal(after.job.commit, box.git(box.web, 'rev-parse', 'HEAD'), 'the queued job is head B');
  const replaced = JSON.parse(readFileSync(join(directory, 'refusal.json'), 'utf8'));
  assert.equal(replaced.error.code, 'SUBMIT_HANDOFF_REPLACED', 'A ends as replaced');
  // A's worker led its own process group with the gate in it; stopping it is what frees A's gate slot.
  await box.helpers.waitFor(() => gone(owner.pid), 'the replaced worker stopped', 120000); // budget: signal delivery ceiling, no timing assertion.
  const heldGate = Number(readFileSync(box.started, 'utf8'));
  await box.helpers.waitFor(() => gone(heldGate), "A's held gate command stopped", 120000); // budget: signal delivery ceiling, no timing assertion.
  await box.helpers.waitFor(() => ['green', 'submitted'].includes(state(box, box.id).job?.state), 'B finished its gate', 120000); // budget: real gate ceiling, no timing assertion.
  assert.equal(state(box, box.id).item.item_status, 'submitted');
  assert.equal(state(box, box.id).item.item_commit, after.job.commit, 'the item is submitted at head B');
});

/** Record every signal a stop attempt sends, sending none. */
function recorder() {
  const sent = [];
  return { sent, kill: (pid, signal) => { sent.push([pid, signal]); } };
}

test('a replaced worker with no recorded start is never signaled [C7,V4]', () => {
  const { sent, kill } = recorder();
  for (const started of [undefined, '', null]) {
    assert.equal(stopReplacedWorker({ job: 'job-a', pid: 4242, started }, { id: 'job-a' }, { startOf: () => 'proc:100', kill }), false);
  }
  assert.deepEqual(sent, []);
});

test('a replaced worker whose PID now has another start is never signaled [C7,V4]', () => {
  const { sent, kill } = recorder();
  assert.equal(stopReplacedWorker({ job: 'job-a', pid: 4242, started: 'proc:100' }, { id: 'job-a' }, { startOf: () => 'proc:200', kill }), false);
  assert.deepEqual(sent, []);
});

test('a replaced worker whose start cannot be read is never signaled [C7,V4]', () => {
  const { sent, kill } = recorder();
  const worker = { job: 'job-a', pid: 4242, started: 'proc:100' };
  assert.equal(stopReplacedWorker(worker, { id: 'job-a' }, { startOf: () => '', kill }), false);
  assert.equal(stopReplacedWorker(worker, { id: 'job-a' }, { startOf: () => { throw new Error('ps unavailable'); }, kill }), false);
  assert.deepEqual(sent, []);
});

test('only the exact recorded incarnation has its process group signaled [C7,V4]', () => {
  const { sent, kill } = recorder();
  assert.equal(stopReplacedWorker({ job: 'job-a', pid: 4242, started: 'proc:100' }, { id: 'job-a' }, { startOf: () => 'proc:100', kill }), true);
  assert.deepEqual(sent, [[-4242, 'SIGTERM']]);
});
