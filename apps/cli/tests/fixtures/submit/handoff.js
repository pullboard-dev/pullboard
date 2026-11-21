/** The shared queued-submit fixture: a real project, board and frozen gate whose release file the test controls [V4,H16,E18]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../e2e.js';
import { openBoard } from '../../../../lib/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { endedSubmitHandoff } from '../../../../../packages/store/index.js';
import { fixtureAdd } from '../testkit.js';
import { fixtureMachineSettings } from '../testkit.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { DatabaseSync } from 'node:sqlite';

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

/** Run `use` on the fixture's board file as a plain connection, closed after; the runner and the CLI write the same file, so a busy wait is set. */
export function withBoardFile(box, use) {
  // @pullboard-board-file journey: read and edit the pulled gate job's persisted steps and lease after its runner stopped or died.
  const db = new DatabaseSync(box.boardFile);
  try { db.exec('PRAGMA busy_timeout = 10000'); return use(db); } finally { db.close(); }
}

/** The board a queued-hand-off test drives directly, opened once here so the raw-board count does not grow. */
export function queueBoard(box) {
  // @pullboard-board-file journey: a second native connection to the fixture board file the real CLI wrote
  return openBoard(box.boardFile, undefined, { gitRoot: box.web });
}

/** The item's newest gate job, with its steps and lease, read from the fixture's board file. */
export function gateJob(box) {
  return withBoardFile(box, db => { const job = jobsOf(db, { kind: 'gate', item: box.id }).at(-1); return job ? jobView(db, job.id) : null; });
}

/** Quote a private fixture path for the actual configured shell command. */
export function word(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Build a native project whose frozen check waits for a real release file, not a timing margin. */
export async function fixture(t, { enabled = true, result = 'green', companion = false, cells = false, firstFolder = false, fourth = false, perSeat = firstFolder ? 2 : null, inProcessHooks } = {}) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  // Isolate admission before init and commit hooks, as well as the nested queued worker.
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  if (inProcessHooks !== undefined) {
    const settings = JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8'));
    fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { ...settings, test: { ...settings.test, inProcessHooks } });
  }
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
  // A cells refusal can return the item to a plain claim before the test claims its second build, so a cells seat holds two.
  const cellsPolicy = cells ? { lanes: { ...config.lanes, web: { ...config.lanes.web, owns: ['web/', 'src/', 'packages/codemap/data/plan/'] } }, claims: { releaseGone: false, releaseCooldownMinutes: 30, ...config.claims, perSeat: 2 } } : {};
  // A first-folder seat claims its second build beside the first, and a journey that holds several builds names its cap [B5];
  // the journey projects pin one claim per seat otherwise.
  const twoClaims = perSeat && !cells ? { claims: { ...config.claims, perSeat } } : {};
  const cellsPlan = cells ? { cells: { ...config.cells, plan: 'packages/codemap/data/plan/cells.json' } } : {};
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: enabled }, ...cellsPolicy, ...twoClaims, ...cellsPlan }, null, 2) + '\n');
  if (cells) {
    mkdirSync(join(box.repo, 'packages/codemap/data/plan'), { recursive: true });
    writeFileSync(join(box.repo, 'packages/codemap/data/plan/cells.json'), JSON.stringify({ version: 1, cells: [], stays: [] }) + '\n');
    box.git(box.repo, 'add', 'packages/codemap/data/plan/cells.json');
  }
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const check = `${word(process.execPath)} ${word(script)}`;
  const id = document(fixtureAdd(box.runSync, box.repo, 'web', cells ? 'Cells move 1/1: captured submit source' : 'Captured submit source', '--specs', 'G1',
    '--criterion', 'The captured candidate passes its real gate.', '--check', check, '--wait', '--json')).item.item_id;
  const third = document(fixtureAdd(box.runSync, box.repo, 'web', 'Third ordinary build', '--specs', 'G1',
    '--criterion', 'An ordinary third build stays refused.', '--check', 'true', '--wait', '--json')).item.item_id;
  const second = document(fixtureAdd(box.runSync, box.repo, 'web', 'Independent second build', '--specs', 'G1',
    '--criterion', 'The second build remains separate.', '--check', 'true', '--accept-green', 'filler build that only holds a second claim', '--wait', '--json')).item.item_id;
  // A journey that holds four claims files its fourth build here: add --wait runs its check on the one local runner, which a held gate would occupy [C7].
  const fourthId = fourth ? document(fixtureAdd(box.runSync, box.repo, 'web', 'Fourth ordinary build', '--specs', 'G1', '--criterion', 'One ordinary build at a time.', '--check', 'true', '--accept-green', 'filler build that only holds a fourth claim', '--wait', '--json')).item.item_id : null;
  const claim = document(box.runSync(box.web, 'claim', String(id), '--json'));
  const source = firstFolder ? claim.itemFolder : box.web;
  // B5: with a second live claim, the commit hook must still stamp the folder's own item.
  const secondFolder = firstFolder ? document(box.runSync(box.web, 'claim', String(second), '--json')).itemFolder : null;
  assert.equal((await helpers.commitFile(box, source, 'web/snapshot.txt', result + '\n', 'feat(web): captured candidate [G1]')).status, 0);
  const commit = box.git(source, 'rev-parse', 'HEAD');
  writeFileSync(armed, 'armed\n');
  t.after(async () => {
    for (const file of releases) writeFileSync(file, 'release\n');
    const job = state(box, id).job;
    if (job) await helpers.waitFor(() => {
      const current = state(box, id).job;
      return current && !existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', current.id, 'source'));
    }, `normal queued worker cleanup: ${workerDiagnostic(box, id)}`);
    await removeSandboxes(helpers);
  });
  return { ...box, helpers, id, second, third, fourth: fourthId, commit, source, secondFolder, release, releases, started, finished };
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
