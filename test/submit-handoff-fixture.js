/** The shared queued-submit fixture: a real project, board and frozen gate whose release file the test controls [V4,H16,E18]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e-helpers.js';
import { openBoard } from '../apps/lib/index.js';
import { getItem } from '../packages/store/index.js';
import { submitHandoff } from '../packages/store/index.js';
import { endedSubmitHandoff } from '../packages/store/index.js';
import { fixtureAdd } from './testkit-fixture.js';
import { driverRecord } from './gate-driver-fixture.js';
import { jobView } from '../packages/jobs/index.js';
import { DISPATCHER_JOB } from '../packages/drive/index.js';

/** Require authentic command success before interpreting any native result. */
export function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read the real SQLite state without writing or inventing a proof receipt; an ended job id also reads that stopped incarnation. */
export function state(box, id, endedId) {
  // @pullboard-board-file journey: observe the separate native worker's actual persisted queue and proof identity.
  const board = openBoard(box.boardFile);
  try {
    return { item: getItem(board, id), job: submitHandoff(board, id), ended: endedId ? endedSubmitHandoff(board, endedId) : null,
      returns: board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id=? AND event_kind='submit_handoff_returned'").get(id).n,
      shouts: board.db.prepare("SELECT shout_text FROM shout WHERE shout_to='coordinator'").all().map(row => row.shout_text) };
  } finally { board.db.close(); }
}

/** Quote a private fixture path for the actual configured shell command. */
export function word(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Build a native project whose frozen check waits for a real release file, not a timing margin. */
export function fixture(t, { enabled = true, result = 'green', companion = false, cells = false, firstFolder = false } = {}) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  // Isolate admission before init and commit hooks, as well as the nested queued worker.
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  const armed = join(box.dir, 'armed');
  const release = join(box.dir, 'release');
  const releases = [release];
  const started = join(box.dir, 'started.jsonl');
  const finished = join(box.dir, 'finished.jsonl');
  const script = join(box.dir, 'gate.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs'); const cp = require('node:child_process');",
    "const value = fs.existsSync('web/snapshot.txt') ? fs.readFileSync('web/snapshot.txt', 'utf8').trim() : 'base';",
    `if (fs.existsSync(${JSON.stringify(armed)}) && value !== 'base') {`,
    ` fs.appendFileSync(${JSON.stringify(started)}, JSON.stringify({value, head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()})+'\\n');`,
    ...(companion ? [" if (fs.readFileSync('api/companion.txt','utf8') !== 'required\\n') throw Error('required companion missing');"] : []),
    ' const deadline = Date.now() + 120000;',
    ` while (!fs.existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) throw Error('fixture release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
    " if (fs.readFileSync('web/snapshot.txt','utf8').trim() !== value) throw Error('captured source changed after builder moved');",
    ` fs.appendFileSync(${JSON.stringify(finished)}, JSON.stringify({value, head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()})+'\\n');`,
    " if (value === 'red') process.exitCode = 1;",
    '}',
  ].join('\n'));
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: enabled }, ...(cells ? { lanes: { ...config.lanes, web: { ...config.lanes.web, owns: ['web/', 'src/', 'bin/'] } } } : {}) }, null, 2) + '\n');
  if (cells) {
    mkdirSync(join(box.repo, 'bin'), { recursive: true });
    writeFileSync(join(box.repo, 'bin/cells-plan.json'), JSON.stringify({ version: 1, cells: [], stays: [] }) + '\n');
    box.git(box.repo, 'add', 'bin/cells-plan.json');
  }
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const check = `${word(process.execPath)} ${word(script)}`;
  const id = document(fixtureAdd(box.run, box.repo, 'web', cells ? 'Cells move 1/1: captured submit source' : 'Captured submit source', '--specs', 'G1',
    '--criterion', 'The captured candidate passes its real gate.', '--check', check, '--wait', '--json')).item.item_id;
  const third = document(fixtureAdd(box.run, box.repo, 'web', 'Third ordinary build', '--specs', 'G1',
    '--criterion', 'An ordinary third build stays refused.', '--check', 'true', '--wait', '--json')).item.item_id;
  const second = document(fixtureAdd(box.run, box.repo, 'web', 'Independent second build', '--specs', 'G1',
    '--criterion', 'The second build remains separate.', '--check', 'true', '--wait', '--json')).item.item_id;
  const claim = document(box.run(box.web, 'claim', String(id), '--json'));
  const source = firstFolder ? claim.itemFolder : box.web;
  // B5: with a second live claim, the commit hook must still stamp the folder's own item.
  const secondFolder = firstFolder ? document(box.run(box.web, 'claim', String(second), '--json')).itemFolder : null;
  assert.equal(helpers.commitFile(box, source, 'web/snapshot.txt', result + '\n', 'feat(web): captured candidate [G1]').status, 0);
  const commit = box.git(source, 'rev-parse', 'HEAD');
  writeFileSync(armed, 'armed\n');
  t.after(async () => {
    for (const file of releases) writeFileSync(file, 'release\n');
    const job = state(box, id).job;
    if (job) await helpers.waitFor(() => {
      const current = state(box, id).job;
      return current && !existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', current.id, 'source'));
    }, `normal queued worker cleanup: ${workerDiagnostic(box, id)}`);
    if (job) await workerGone(helpers, box, job.id);
    await removeSandboxes(helpers);
  });
  return { ...box, helpers, id, second, third, commit, source, secondFolder, release, releases, started, finished };
}


/**
 * Wait for the job's own supervisor to exit before removing its tree, without blocking the event loop.
 * Why: node:test runs a test's after hooks once run-tests arms its 30 s file-exit ceiling, so teardown that
 * races a still-exiting supervisor must wait for it asynchronously and stay well under that ceiling.
 */
export async function workerGone(helpers, box, job) {
  let pid;
  try { pid = driverRecord(box.boardFile ?? join(box.repo, '.git', 'pullboard', 'board.sqlite'), job)?.pid; } catch { return; /* No launched driver to wait for. */ }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  await helpers.waitFor(() => { // budget: owned supervisor exit ceiling inside the file-exit window, not a timing assertion.
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }, `queued submit supervisor ${pid} exit before fixture removal`, 10_000);
}

/**
 * Wait until a fixture's gate processes have made their last write: the job's driver has exited and the board's
 * dispatcher row is free, which the dispatcher writes last before it exits.
 * Why: both outlive the job's terminal record by design. The driver ends its drive job and removes its checkout after
 * it records the result, and the dispatcher's last pass records the worker cap under the machine home and then frees
 * its board row. A fixture removed under them got a folder back after rmSync had walked past it, and rmSync then slept
 * in its retry backoff on the root until run-tests killed the file (#3495).
 *
 * @param {any} helpers - The fixture's e2e helpers.
 * @param {{ boardFile?: string, repo: string }} box - The fixture project.
 * @param {string | undefined} job - The hand-off job whose driver must exit, when one was queued.
 */
export async function gateSettled(helpers, box, job) {
  const boardFile = box.boardFile ?? join(box.repo, '.git', 'pullboard', 'board.sqlite');
  if (job) await workerGone(helpers, { ...box, boardFile }, job);
  await helpers.waitFor(() => { // budget: dispatcher last-pass ceiling inside the file-exit window, not a timing assertion.
    // @pullboard-board-file journey: read the dispatcher's own board row, the last thing it writes before it exits.
    const board = openBoard(boardFile);
    try {
      const row = jobView(board.db, DISPATCHER_JOB);
      return !row?.leaseOwner || row.leaseUntil < Date.now();
    } finally { board.db.close(); }
  }, 'the gate dispatcher frees its board row before fixture removal', 15_000);
}

/**
 * Remove this fixture's sandboxes with asynchronous retries and a bound under the file-exit ceiling.
 * Why: the shared helper's synchronous rmSync retries for up to 30 s, so a late writer froze the main thread
 * until run-tests killed the whole file (#2934); a named failure here says which entries kept appearing.
 */
export async function removeSandboxes(helpers) {
  for (const dir of helpers.sandboxes) {
    let last;
    /** One removal attempt; a late writer's transient refusal is retried, any other error surfaces at once. */
    const removed = () => {
      try { rmSync(dir, { recursive: true, force: true }); return true; }
      catch (error) { if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error.code)) throw error; last = error; return false; }
    };
    try { await helpers.waitFor(removed, `fixture removal of ${dir}`, 15_000); } // budget: late-writer ceiling below the 30 s file-exit timeout, not a timing assertion.
    catch (error) {
      let left = [];
      try { left = readdirSync(dir, { recursive: true }).slice(0, 20); } catch { /* The directory may already be gone. */ }
      throw new Error(`${error.message} kept failing (${last?.code}); entries still present: ${left.join(', ')}`, { cause: last ?? error });
    }
  }
}

/** Retain a bounded native failure witness before cleanup can hide a failed worker result. */
export function workerDiagnostic(box, id) {
  const current = state(box, id);
  if (!current.job) return JSON.stringify(current);
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', current.job.id);
  const log = join(directory, 'worker.log');
  const merge = join(directory, 'output', 'merge-failure.log');
  return JSON.stringify({ item: current.item.item_status, job: current.job,
    worker: existsSync(log) ? readFileSync(log, 'utf8').slice(-6000) : null,
    merge: existsSync(merge) ? readFileSync(merge, 'utf8').slice(-6000) : null });
}

/** Wait for a real terminal state, exposing a stopped worker's retained refusal instead of hiding it in teardown. */
export async function waitJob(box, expected) {
  try { await box.helpers.waitFor(() => { // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
    const current = state(box, box.id);
    if (current.job?.state === expected) return true;
    if (current.job) {
      const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', current.job.id);
      if (existsSync(join(directory, 'refusal.json')) && !existsSync(join(directory, 'source'))) {
        assert.fail(`worker stopped before native completion: ${workerDiagnostic(box, box.id)}`);
      }
    }
    return false;
  }, `native ${expected} result`, 120000); }
  catch (error) { throw new Error(`${error.message}\n${workerDiagnostic(box, box.id)}`, { cause: error }); }
}

/** Make a real later builder commit without replacing the queued source. */
export function helpersCommit(box, path, body) {
  return box.helpers.commitFile(box, box.web, path, body, 'feat(web): independent later work [G1]');
}
