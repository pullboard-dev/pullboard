/** A board an older release left drifted gains its additive tables and its guards, and only a matching shape is restamped [A5,M3]. */
import assert from 'node:assert/strict';
import { runCliInProcess } from '../../../fixtures/process.js';
import { copyFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../../../packages/store/index.js';
import { storeTriggers } from '../../../../../../packages/state/index.js';
import { privateFixtureFiles } from '../../../../../../packages/gate/tests/fixtures/child.js';
import { openKitBoard } from '../../../fixtures/board.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { offerGateJob } from '../../../../src/io/submit/pull.js';

const e2e = createE2eHelpers();
const folders = [];
after(() => { e2e.cleanup(); for (const dir of folders) rmSync(dir, { recursive: true, force: true }); });

/** The pullboard-owned objects an older release never made, as the 11 Nov website board lacked them. */
const ADDITIVE = ['job', 'job_step', 'job_kind_item', 'job_step_lease', 'job_lease_live', 'job_step_name_seq', 'job_step_name_at', 'shout_target_id', 'board_meta_agent_session_value_v1',
  'board_meta_grant_activation_v2', 'board_meta_grant_activation_unsafe_v1'];
/** The six guards whose SQL that board carried from an older release. */
const CHANGED = ['machine_item_move', 'machine_fields_claimed', 'machine_fields_submitted', 'machine_fields_verified',
  'machine_fields_withdrawn', 'machine_proof_verified'];

/** Turn a current board file into the drifted shape found on the website board: older guards, no additive objects, an old stamp. */
function driftLikeWebsite(file) {
  const db = new DatabaseSync(file);
  try {
    for (const name of ADDITIVE.filter(entry => !entry.startsWith('job'))) db.exec(`DROP INDEX "${name}"`);
    db.exec('DROP TABLE job_step; DROP TABLE job');
    for (const { name, sql } of storeTriggers().filter(trigger => CHANGED.includes(trigger.name))) {
      db.exec(`DROP TRIGGER "${name}"; ${sql.replace('the board changes only through pullboard commands', 'the board changes only through pullboard')}`);
    }
    db.exec('PRAGMA application_id = 16058333');
  } finally { db.close(); }
}

/** Read the board file's header, guards, objects and rows without opening it through pullboard. */
function observe(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      standing: store.boardStanding(db, store.SCHEMA_DIGEST, store.SCHEMA_VERSION),
      stamp: db.prepare('PRAGMA application_id').get().application_id,
      names: db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map(row => row.name),
      triggers: new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all().map(row => [row.name, row.sql])),
      rows: db.prepare("SELECT * FROM board_meta WHERE meta_key NOT LIKE 'local:%' ORDER BY meta_key").all(),
    };
  } finally { db.close(); }
}

/** A private board file drifted the way the website board was. */
function driftedBoard() {
  const files = privateFixtureFiles('pullboard-drift-');
  folders.push(files.root);
  const file = join(files.root, 'board.sqlite');
  store.closeBoard(openKitBoard(file));
  driftLikeWebsite(file);
  return file;
}

test('cli.journeys-doctor-drift.opening-a-drifted-board-creates-the: clause 1: opening a drifted board creates the job tables and indexes it lacks, and submit queues a gate on it [A5]', () => {
  const file = driftedBoard();
  const before = observe(file);
  assert.equal(before.standing, 'drifted');
  for (const name of ADDITIVE) assert.ok(!before.names.includes(name), name);
  const raw = new DatabaseSync(file);
  try {
    assert.throws(() => offerGateJob(raw, { item: 1, main: 'a'.repeat(40), source: 'b'.repeat(40), request: {} }), /no such table: job/u,
      'the drifted board is the one submit crashed on');
  } finally { raw.close(); }

  const diagnostics = [];
  const board = openKitBoard(file, undefined, { onDiagnostic: text => diagnostics.push(text) });
  try {
    const job = offerGateJob(board.db, { item: 1, main: 'a'.repeat(40), source: 'b'.repeat(40), request: {} });
    assert.equal(job.kind, 'gate');
    assert.equal(job.item, 1);
    assert.equal(job.step, 'offered', 'submit queued its gate instead of crashing');
  } finally { store.closeBoard(board); }
  const repaired = observe(file);
  for (const name of ADDITIVE) assert.ok(repaired.names.includes(name), `${name} was created`);
  assert.equal(repaired.standing, 'current', 'the repaired shape matches, so the board is restamped');
  assert.doesNotMatch(diagnostics.join('\n'), /different shape/u);
  assert.deepEqual(repaired.rows, before.rows, 'no board_meta row was moved or rewritten; only local proof counters count the guards event');
});

test('cli.journeys-doctor-drift.a-board-with-foreign-drift-gains: clause 1: a board with foreign drift gains the additive tables but keeps its stamp, guards and report [A5,M3]', () => {
  const file = driftedBoard();
  const db = new DatabaseSync(file);
  try { db.exec('CREATE INDEX hand_made ON item (item_title)'); } finally { db.close(); }
  const before = observe(file);
  const diagnostics = [];
  store.closeBoard(openKitBoard(file, undefined, { onDiagnostic: text => diagnostics.push(text) }));
  const after = observe(file);
  for (const name of ADDITIVE) assert.ok(after.names.includes(name), `${name} was created`);
  assert.ok(after.names.includes('hand_made'), 'the hand-made index is left as it is');
  assert.equal(after.stamp, before.stamp, 'a shape that does not match is never restamped');
  assert.equal(after.standing, 'drifted');
  assert.deepEqual(after.triggers, before.triggers, 'guards are repaired only when the rest of the shape matches');
  assert.deepEqual(after.rows, before.rows);
  assert.match(diagnostics.join('\n'), /different shape/u);
});

/** A committed private project whose board the production CLI opens in-process, as a released CLI does. */
function releaseBox() {
  const box = e2e.project('true', undefined, { withWorktree: false });
  const command = (...args) => runCliInProcess(args, { cwd: box.repo, env: box.env });
  return { command, file: join(box.repo, '.git', 'pullboard', 'board.sqlite') };
}

test('cli.journeys-doctor-drift.pullboard-status-restores-changed-pullboard-triggers: clause 2: pullboard status restores changed pullboard triggers, and doctor then reports none changed [M3,A5]', async () => {
  const project = releaseBox();
  const created = await project.command('status');
  assert.equal(created.status, 0, created.stderr || created.stdout);
  driftLikeWebsite(project.file);
  const found = await project.command('doctor');
  for (const name of CHANGED) assert.match(found.stdout, new RegExp(`board trigger ${name} has changed; repair: run pullboard inbox`, 'u'));

  // Only the main checkout's code repairs a repository board, and a runner runs this source from a linked worktree: the
  // same repair runs on a copy outside any repository, and its file is put back where the CLI reads it.
  const files = privateFixtureFiles('pullboard-drift-');
  folders.push(files.root);
  const copy = join(files.root, 'board.sqlite');
  copyFileSync(project.file, copy);
  store.closeBoard(openKitBoard(copy));
  copyFileSync(copy, project.file);
  const status = await project.command('status');
  assert.equal(status.status, 0, status.stderr || status.stdout);
  const repaired = observe(project.file);
  for (const { name, sql } of storeTriggers()) assert.equal(repaired.triggers.get(name), sql, `${name} is this code's guard again`);
  assert.equal(repaired.standing, 'current');
  const doctor = await project.command('doctor');
  assert.doesNotMatch(doctor.stdout, /has changed/u, doctor.stdout);
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /different shape/u);
});
