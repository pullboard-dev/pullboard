/** A test that breaks on main after a sprint landing pulls the item out with no hand command: the main-wide test job goes red, the item reopens, and main takes a revert; a steady board queues no such job [M2,R3,#12184]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
// Budget: each wait (gate, screen, land job and pull-out), well inside the file's kill.
const WAIT_MS = 60_000;
// Budget: declared per case, so one stuck case ends with its step diagnostics inside the file's kill.
const CASE_MS = 150_000;

/** A landing project whose pullboard.json on main lets the board land on its own and carries `pace` (steady: the key left out), pushed before any item is claimed. */
function pacedProject(pace, mark) {
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject({ withWorktree: false });
  // The fixture gate fails a FLAKE file in a full run only once main on origin holds it: the item's own gate is green, the run after its landing red.
  box.env.LAND_RED_AFTER_LANDING = '1';
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const landing = { ...(config.landing ?? {}) };
  delete landing.manualOverride;
  writeFileSync(file, JSON.stringify({ ...config, landing, ...(pace === 'steady' ? {} : { pace }) }, null, 2) + '\n');
  box.git(box.repo, 'commit', '-q', '-am', `chore(board): automatic landing, pace ${pace}`);
  const pushed = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(pushed.status, 0, pushed.stderr);
  mark(`landing project with pace ${pace} committed and pushed`);
  return { box, fixtures };
}

/** File, claim, build (a change that breaks the full suite) and `submit --no-next` one item through the CLI, then wait for its gate receipt to apply. */
async function submitOne({ box, fixtures }, mark) {
  const entry = await fixtures.itemWorktreeLocal(box, 1);
  // FLAKE: with LAND_RED_AFTER_LANDING the file passes every run until main holds it, then fails the full run, as a main test no import links to it.
  await fixtures.commitItemLocal(box, entry, 'FLAKE\n');
  // A screen is a keyed result, never done, so the fixture's all-jobs-done settle is off and the gate is awaited below.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  try {
    const submitted = await box.runAsync(entry.path, 'submit', String(entry.item), '--no-next', '--json');
    assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  } finally { delete box.env.PULLBOARD_FIXTURE_UNSETTLED; }
  await settledGateJob(box, entry.item, { deadlineMs: WAIT_MS });
  mark(`#${entry.item} submitted and its gate receipt applied`);
  return entry;
}

/** One read-only query on the board the real CLI and its runner wrote. */
function boardRead(box, sql, ...args) {
  // @pullboard-board-file journey: a read-only look at the rows the real CLI and its runner wrote.
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(sql).all(...args).map(row => ({ ...row }));
  } finally { db.close(); }
}

const itemRow = (box, id) => boardRead(box, 'SELECT item_status, item_merged_commit FROM item WHERE item_id = ?', id)[0];
const pullOutJobs = (box, id) => boardRead(box, "SELECT job_id FROM job WHERE job_kind = 'pull-out' AND job_item = ?", id).length;
const pulledEvents = (box, id) => boardRead(box, "SELECT event_id FROM event WHERE event_kind = 'pulled' AND item_id = ?", id).length;
// The trunk is main on the bare origin the land jobs push to; the pull-out pushes its revert there too.
const trunkSubject = box => box.tryGit(box.remote, 'log', '-1', '--format=%s', 'main').stdout.trim();
const trunkTip = box => box.tryGit(box.remote, 'rev-parse', 'main').stdout.trim();

/** Each step's elapsed seconds as a test diagnostic, so a case that runs out of time names the step it stood at. */
function marker(t) {
  const started = Date.now();
  return label => t.diagnostic(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);
}

const postLandJobs = box => boardRead(box, "SELECT job_id FROM job WHERE job_kind = 'test' AND job_id LIKE 'post-land:%'").length;

test('cli.sprint.main-break-pulls-out: clause 1: a sprint item whose landing breaks a main test no import links to it is pulled out with no hand command: a main-wide test job runs, the item reads open, and main is a revert [M2,R3,#12184]', { timeout: CASE_MS }, async t => {
  const mark = marker(t);
  const { box, fixtures } = pacedProject('sprint', mark);
  const entry = await submitOne({ box, fixtures }, mark);
  const id = entry.item;
  const landed = await helpers.waitFor(() => itemRow(box, id)?.item_merged_commit ?? null, 'the sprint item landed', WAIT_MS); // budget: declared WAIT_MS
  mark(`#${id} landed at ${landed.slice(0, 12)}`);
  await helpers.waitFor(() => /^Revert /u.test(trunkSubject(box)), 'main takes the revert of the landing', WAIT_MS); // budget: declared WAIT_MS
  mark(`main reverted: ${trunkSubject(box)}`);
  assert.equal(postLandJobs(box), 1, 'one main-wide test job ran on the landed tip');
  assert.equal(pullOutJobs(box, id), 1, 'the board holds one pull-out job');
  assert.equal(pulledEvents(box, id), 1, 'the board holds one pulled event');
  const shown = await box.runAsync(box.repo, 'show', String(id));
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, new RegExp(`#${id}\\s+open\\b`, 'u'), shown.out);
});

test('cli.sprint.main-break-steady-unchanged: clause 2: the same break on a steady board queues no main-wide test job and no pull-out, and main is unchanged, as today [M2,R3,#12184]', { timeout: CASE_MS }, async t => {
  const mark = marker(t);
  const { box, fixtures } = pacedProject('steady', mark);
  const before = trunkTip(box);
  const entry = await submitOne({ box, fixtures }, mark);
  const id = entry.item;
  assert.equal(postLandJobs(box), 0, 'a steady board queues no main-wide test job');
  assert.equal(pullOutJobs(box, id), 0, 'no pull-out job');
  assert.equal(pulledEvents(box, id), 0, 'no pulled event');
  assert.equal(itemRow(box, id).item_merged_commit, null, 'a steady item waits for its accept, as today');
  assert.equal(trunkTip(box), before, 'main is unchanged');
});
