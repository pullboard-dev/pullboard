/** After a sprint landing breaks main and is pulled out, the next sprint item lands only once the pull-out has recorded pulled, so its merge never sits on the red tip [V2,M1,#12502]. */
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
async function submitOne({ box, fixtures }, mark, { number = 1, contents = 'FLAKE\n' } = {}) {
  const entry = await fixtures.itemWorktreeLocal(box, number);
  // FLAKE: with LAND_RED_AFTER_LANDING the file passes every run until main holds it, then fails the full run, as a main test no import links to it.
  await fixtures.commitItemLocal(box, entry, contents);
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
const pulledEvents = (box, id) => boardRead(box, "SELECT event_id FROM event WHERE event_kind = 'pulled' AND item_id = ?", id).length;
// The trunk is main on the bare origin the land jobs push to; the pull-out pushes its revert there too.
const trunkSubject = box => box.tryGit(box.remote, 'log', '-1', '--format=%s', 'main').stdout.trim();
const trunkTip = box => box.tryGit(box.remote, 'rev-parse', 'main').stdout.trim();

/** Each step's elapsed seconds as a test diagnostic, so a case that runs out of time names the step it stood at. */
function marker(t) {
  const started = Date.now();
  return label => t.diagnostic(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);
}


test('cli.sprint.red-main-holds-next: clause 2: after item 1 lands and its main-wide test finishes red, item 2 is submitted and gets no land job until the pull-out of item 1 records pulled, then it lands, and main never holds item 2 merge on top of the red tip [V2,M1,#12502]', { timeout: CASE_MS * 2 }, async t => {
  const mark = marker(t);
  const project = pacedProject('sprint', mark);
  const { box } = project;
  const first = await submitOne(project, mark);
  await helpers.waitFor(() => itemRow(box, first.item)?.item_merged_commit ?? null, 'the first sprint item landed', WAIT_MS); // budget: declared WAIT_MS
  await helpers.waitFor(() => /^Revert /u.test(trunkSubject(box)), 'main takes the revert of the first landing', WAIT_MS); // budget: declared WAIT_MS
  const revert = trunkTip(box);
  await helpers.waitFor(() => pulledEvents(box, first.item) === 1 || null, 'the pull-out of the first item records pulled', WAIT_MS); // budget: declared WAIT_MS
  mark(`#${first.item} pulled out, main at ${revert.slice(0, 12)}`);
  const second = await submitOne(project, mark, { number: 2, contents: 'PASS\n' });
  const landed = await helpers.waitFor(() => itemRow(box, second.item)?.item_merged_commit ?? null, 'the second sprint item landed', WAIT_MS); // budget: declared WAIT_MS
  mark(`#${second.item} landed at ${landed.slice(0, 12)}`);
  // No land job names the second item before the first item's pulled event, so its merge never sat on the red tip.
  const pulledAt = Date.parse(boardRead(box, "SELECT event_at FROM event WHERE event_kind = 'pulled' AND item_id = ?", first.item)[0]?.event_at);
  assert.ok(Number.isFinite(pulledAt), 'the first item has its pulled event');
  const offers = boardRead(box, "SELECT j.job_created AS at FROM job j JOIN job_step s ON s.job_step_job = j.job_id AND s.job_step_name = 'offered' WHERE j.job_kind = 'land' AND s.job_step_payload LIKE ? ORDER BY j.job_created", `%"id":${second.item},%`);
  assert.ok(offers.length >= 1, 'a land job names the second item');
  assert.ok(offers.every(row => row.at >= pulledAt), 'no land job named the second item before the first item was pulled');
  assert.equal(pulledEvents(box, first.item), 1, 'one pulled event for the red landing');
  assert.equal(itemRow(box, second.item).item_status, 'submitted', 'the second item stays landed');
});
