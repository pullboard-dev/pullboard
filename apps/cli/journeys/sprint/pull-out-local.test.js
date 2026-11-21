/** A reject of landed sprint work on a board with no trunk remote still runs its pull-out: the host repository's own trunk takes the revert and the board records pulled [M2,R3,#12501]. */
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
// Budget: the revert is pushed inside the reject command, so its wait is short and a missing revert leaves the steady case its time.
const REVERT_MS = 15_000;
const CLAUSE = 'land fixture 1 remains valid';
const NOTE = 'fixture reject of landed work: the landed change breaks its clause';

/** A landing project whose pullboard.json on main lets the board land on its own and carries `pace` (steady: the key left out), pushed before any item is claimed. */
function pacedProject(pace, mark) {
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject({ withWorktree: false });
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const landing = { ...(config.landing ?? {}) };
  delete landing.manualOverride;
  writeFileSync(file, JSON.stringify({ ...config, landing, ...(pace === 'steady' ? {} : { pace }) }, null, 2) + '\n');
  box.git(box.repo, 'commit', '-q', '-am', `chore(board): automatic landing, pace ${pace}`);
  const pushed = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(pushed.status, 0, pushed.stderr);
  // No trunk remote: the host's own repository is trunk, so the fixture's origin goes and trunk.remote stays empty.
  box.git(box.repo, 'remote', 'remove', 'origin');
  mark(`landing project with pace ${pace} committed, no remote`);
  return { box, fixtures };
}

/** File, claim, build and `submit --no-next` one item through the CLI, then wait for its gate receipt to apply. */
async function submitOne({ box, fixtures }, mark) {
  const entry = await fixtures.itemWorktreeLocal(box, 1);
  await fixtures.commitItemLocal(box, entry);
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
// With no trunk remote the trunk is main in the board host's own repository, which the local runner lands into.
const trunkSubject = box => box.tryGit(box.repo, 'log', '-1', '--format=%s', 'main').stdout.trim();

/** Each step's elapsed seconds as a test diagnostic, so a case that runs out of time names the step it stood at. */
function marker(t) {
  const started = Date.now();
  return label => t.diagnostic(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);
}

/**
 * The coordinator's reject of `id` from the main checkout, as the coordinator runs it, with no next. Work not yet on main is
 * reviewed with the checkout detached at the submitted commit, and main is checked out again after.
 */
async function reject(box, id) {
  const commit = boardRead(box, 'SELECT item_commit FROM item WHERE item_id = ?', id)[0].item_commit;
  const landed = box.tryGit(box.repo, 'merge-base', '--is-ancestor', commit, 'main').status === 0;
  if (!landed) box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    return await box.runAsync(box.repo, 'verify', String(id), 'reject', '--no-next', '--reason', 'TEST_FAILURE', '--clause', CLAUSE, '--note', NOTE, '--as', 'coordinator');
  } finally { if (!landed) box.git(box.repo, 'switch', '-q', 'main'); }
}

test('cli.sprint.reject-pulls-out-local: clause 1: a reject of landed sprint work on a board with no trunk remote reverts its merge on the host trunk, leaves one pull-out job and one pulled event, and reopens the item [M2,R3,#12501]', { timeout: CASE_MS }, async t => {
  const mark = marker(t);
  const { box, fixtures } = pacedProject('sprint', mark);
  assert.equal(box.tryGit(box.repo, 'remote').stdout.trim(), '', 'the project has no remote');
  const entry = await submitOne({ box, fixtures }, mark);
  const id = entry.item;
  const landed = await helpers.waitFor(() => itemRow(box, id)?.item_merged_commit ?? null, 'the sprint item landed', WAIT_MS); // budget: declared WAIT_MS
  mark(`#${id} landed at ${landed.slice(0, 12)}`);
  const verdict = await reject(box, id);
  assert.equal(verdict.code, 0, `${verdict.err}\n${verdict.out}`);
  mark(`#${id} rejected${(verdict.err ?? '').trim() ? `; stderr: ${verdict.err.trim().slice(0, 400)}` : ''}`);
  // The reject runs the pull-out before it returns, so the revert is on the host trunk at once; the wait covers only the settling.
  await helpers.waitFor(() => /^Revert /u.test(trunkSubject(box)), 'main takes the revert of the landing', REVERT_MS); // budget: declared REVERT_MS
  assert.equal(pullOutJobs(box, id), 1, 'the board holds one pull-out job');
  assert.equal(pulledEvents(box, id), 1, 'the board holds one pulled event');
  assert.equal(itemRow(box, id).item_status, 'open', 'the item is open again');
});
