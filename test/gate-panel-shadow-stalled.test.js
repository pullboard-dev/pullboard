/** The gate panel calls a lease-free shadow gate stalled only when no live hand-off worker runs it [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureAdd } from './testkit-fixture.js';
import { submitHandoff } from '../packages/store/index.js';
import { HANDOFF_DISPATCHER_RESOURCE, takeResource } from '../packages/resources/index.js';
import { createJob, writeStep, takeJob, gatePanel, stalledGates, LEASE_MS } from '../packages/jobs/index.js';

const files = privateFixtureFiles('pullboard-gate-shadow-stalled-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openBoard(join(files.root, `${name}.sqlite`));
  try { return body(board.db); } finally { closeBoard(board); }
}

test('clause 1: a running shadow gate job whose hand-off worker is alive reads running, not stalled [C7]', () => {
  withBoard('shadow', (db) => {
    const now = 10 * 60_000;
    createJob(db, { id: 'alive', kind: 'gate', item: 1, now: 0 });
    writeStep(db, 'alive', 'running', {}, { now: 0 });
    createJob(db, { id: 'orphan', kind: 'gate', item: 2, now: 0 });
    writeStep(db, 'orphan', 'running', {}, { now: 0 });
    createJob(db, { id: 'leased', kind: 'gate', item: 3, now: 0 });
    takeJob(db, 'leased', 'driver', { now: 1000 });
    writeStep(db, 'leased', 'running', {}, { now: 1000 });
    const workerAlive = (view) => view.id !== 'orphan';
    assert.equal(gatePanel(db, 'alive', { now, workerAlive }).text, 'running');
    assert.equal(gatePanel(db, 'orphan', { now, workerAlive }).stalled, true);
    assert.match(gatePanel(db, 'orphan', { now, workerAlive }).text, /^stalled \(reclaimable\) \d+m$/u);
    assert.equal(gatePanel(db, 'leased', { now: now + LEASE_MS, workerAlive }).stalled, true, 'a lapsed lease is stalled whatever the worker says');
    assert.deepEqual(stalledGates(db, { now: now + LEASE_MS, workerAlive }).map(row => row.id).sort(), ['leased', 'orphan']);
    assert.equal(gatePanel(db, 'alive', { now }).stalled, true, 'with no worker signal the lease-free row still reads stalled');
  });
});

/** Run `work` with this process's machine home set to the fixture's, so its resources are the fixture's own. */
async function inMachineHome(box, work) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  try { return await work(); }
  finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** Require authentic command success and parse its JSON document. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

test('clause 1: show and status read a lease-free running shadow gate as running while its hand-off worker is alive, stalled once it is gone [C7]', async t => {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  const box = helpers.project('true', isolated);
  // The test holds the one dispatcher place, so no real worker starts and the job stays queued.
  const dispatcher = await inMachineHome(box, () => takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'shadow-stalled-fixture' }));
  t.after(() => { dispatcher.release(); helpers.cleanup(); });
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Shadow stalled handoff', '--specs', 'G1', '--route', 'strong',
    '--criterion', 'A live worker keeps the gate running.', '--check', 'true', '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/shadow.txt', 'shadow\n', 'feat(web): shadow candidate [G1]').status, 0);
  assert.equal(document(box.run(box.web, 'submit', String(id), '--no-next', '--json')).queued, true);
  const board = openBoard(box.boardFile);
  let job;
  try {
    job = submitHandoff(board, id);
    createJob(board.db, { id: job.id, kind: 'gate', item: id, candidate: job.commit, base: job.main, now: 0 });
    writeStep(board.db, job.id, 'running', {}, { now: 0 });
  } finally { board.db.close(); }
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id);
  mkdirSync(directory, { recursive: true });
  const record = pid => writeFileSync(join(directory, 'worker.json'), JSON.stringify({ version: 1, job: job.id, pid, started: null, relaunches: 0 }) + '\n');

  record(process.pid);
  assert.equal(document(box.run(box.repo, 'show', String(id), '--json')).gateText, 'running', 'show: a live worker keeps the lease-free gate running');
  assert.deepEqual(document(box.run(box.repo, 'status', '--json')).stalledGates.filter(row => row.id === job.id), [], 'status: not listed stalled');

  const gone = spawnSync(process.execPath, ['-e', '']);
  record(gone.pid);
  assert.match(document(box.run(box.repo, 'show', String(id), '--json')).gateText, /^stalled \(reclaimable\)/u, 'show: a dead worker reads stalled');
  assert.equal(document(box.run(box.repo, 'status', '--json')).stalledGates.filter(row => row.id === job.id).length, 1, 'status: listed stalled');
});
