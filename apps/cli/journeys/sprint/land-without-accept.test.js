/** A submitted sprint item lands with no accept once its screen is green; a steady item waits for its accept and lands after it [V2,M1,#12177]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import { localRunnerState } from '../../../../packages/drive/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { fixtureRunnerFolder } from '../../tests/fixtures/runner/local-start.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';
import { verifySettled } from '../../tests/fixtures/submit/settle.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
// Budget: each wait (gate, screen and land job), well inside the file's kill.
const WAIT_MS = 60_000;
// Budget: declared per case, so one stuck case ends with its step diagnostics inside the file's kill.
const CASE_MS = 150_000;

/**
 * A landing project (a real bare origin, as the runner land job pushes to it) whose pullboard.json on main lets the board land
 * on its own and carries `pace` (steady: the key left out, as a board that never set it), pushed before any item is claimed.
 */
function pacedProject(pace, mark) {
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject({ withWorktree: false });
  mark('landing project built');
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const landing = { ...(config.landing ?? {}) };
  delete landing.manualOverride;
  writeFileSync(file, JSON.stringify({ ...config, landing, ...(pace === 'steady' ? {} : { pace }) }, null, 2) + '\n');
  box.git(box.repo, 'commit', '-q', '-am', `chore(board): automatic landing, pace ${pace}`);
  const pushed = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(pushed.status, 0, pushed.stderr);
  mark(`automatic landing and pace ${pace} committed and pushed`);
  return { box, fixtures };
}

/** Require native CLI success and read its JSON reply. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** File, claim, build and `submit --no-next` one item through the CLI, then wait for its gate receipt to apply; no reviewer command runs. */
async function submitOne({ box, fixtures }, mark) {
  const entry = await fixtures.itemWorktreeLocal(box, 1);
  mark(`filed and claimed #${entry.item}`);
  await fixtures.commitItemLocal(box, entry);
  // The fixture's own settle waits for every job row to read done; a screen is a keyed result, never done, so the gate is awaited below instead.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  try { document(await box.runAsync(entry.path, 'submit', String(entry.item), '--no-next', '--json')); } finally { delete box.env.PULLBOARD_FIXTURE_UNSETTLED; }
  mark(`submitted #${entry.item}`);
  await settledGateJob(box, entry.item, { deadlineMs: WAIT_MS });
  mark(`gate receipt applied for #${entry.item}`);
  return entry;
}

/** The item's row as the board holds it, read-only. */
function itemRow(box, id) {
  // @pullboard-board-file journey: a read-only look at the item the real CLI and its runner wrote.
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return { ...db.prepare('SELECT item_status, item_merged_commit FROM item WHERE item_id = ?').get(id) };
  } finally { db.close(); }
}

/** Each step's elapsed seconds as a test diagnostic, so a case that runs out of time names the step it stood at. */
function marker(t) {
  const started = Date.now();
  return label => t.diagnostic(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);
}

/** The local runner's last heartbeat time; the runner process that applied the receipt writes it on a timer. */
function heartbeatAt(box) {
  return Number(localRunnerState(fixtureRunnerFolder(box.env), Date.now(), box.env.PULLBOARD_HOME || null)?.heartbeatAt ?? 0);
}

/** Wait until the board records a merged commit for the item. */
function landed(box, id, what) {
  return helpers.waitFor(() => { const read = itemRow(box, id); return read.item_merged_commit ? read : null; }, what, WAIT_MS); // budget: declared WAIT_MS, the same bound as the gate settle
}

test('cli.sprint.lands-without-accept: clause 1: on a fresh board with pace sprint, after submit --no-next and no reviewer command, show prints merged as and list gives the item a merged commit while it is still submitted [V2,M1,#12177]', { timeout: CASE_MS }, async t => {
  const mark = marker(t);
  const project = pacedProject('sprint', mark);
  const { box } = project;
  const { item: id, commit } = await submitOne(project, mark);
  const row = await landed(box, id, 'the sprint item landed');
  mark(`#${id} landed at ${row.item_merged_commit.slice(0, 12)}`);
  const shown = await box.runAsync(box.repo, 'show', String(id), '--no-next');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /^merged as /mu, shown.out);
  const listed = document(await box.runAsync(box.repo, 'list', '--all', '--json')).items.find(item => item.item_id === id);
  assert.match(listed?.item_merged_commit ?? '', /^[0-9a-f]{40}$/u, JSON.stringify(listed));
  assert.equal(listed.item_status, 'submitted', 'no accept was given: the landed item is still submitted');
  assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', commit, 'main').status, 0, 'main holds the item commit');
});

test('cli.sprint.steady-waits-for-accept: clause 2: on a steady board the submitted item does not land without an accept, and lands after one, as today [V2,M1,#12177]', { timeout: CASE_MS }, async t => {
  const mark = marker(t);
  const project = pacedProject('steady', mark);
  const { box } = project;
  const { item: id, commit } = await submitOne(project, mark);
  // The runner process that applied the receipt beats on a timer: once it beats after the receipt, any landing it started has been offered.
  const applied = Date.now();
  await helpers.waitFor(() => heartbeatAt(box) > applied, 'the local runner heartbeat after the receipt', WAIT_MS); // budget: declared WAIT_MS; the heartbeat is every 5 s
  assert.deepEqual(itemRow(box, id), { item_status: 'submitted', item_merged_commit: null }, 'a steady item does not land without an accept');
  // The accept runs in the main checkout at the submitted commit, as a reviewer runs it; that leaves main detached, so its own
  // land offer stands down, and `land` then offers the job for the accepted item no land job names, as it does today.
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const verdict = await verifySettled(box, box.runAsync, box.repo, ['verify', String(id), 'accept', '--as', 'coordinator', '--note', 'fixture check passed at the submitted commit']);
    assert.equal(verdict.code, 0, verdict.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  document(await box.runAsync(box.repo, 'land', '--json'));
  mark(`accepted #${id}`);
  const row = await landed(box, id, 'the accepted steady item landed');
  assert.match(row.item_merged_commit, /^[0-9a-f]{40}$/u, 'the steady item landed after its accept');
});
