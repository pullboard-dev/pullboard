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
import { fixtureRunnerFolder } from '../../tests/fixtures/runner/local-start.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';
import { verifySettled } from '../../tests/fixtures/submit/settle.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
// Budget: each wait (gate, screen and land job), well inside the file's kill.
const WAIT_MS = 40_000;
// Budget: declared per case, so one stuck case ends with its step diagnostics inside the file's kill.
const CASE_MS = 100_000;

/** A fixture project whose pullboard.json on main carries `pace` (steady: the key left out, as a board that never set it), merged into the web seat before any claim. */
function pacedProject(pace, mark) {
  const box = helpers.project('true');
  mark('project built');
  if (pace === 'steady') return box;
  const file = join(box.repo, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pace }, null, 2) + '\n');
  box.git(box.repo, 'commit', '-q', '-am', `chore(board): pace ${pace}`);
  box.git(box.web, 'merge', '-q', 'main');
  mark(`pace ${pace} committed and merged into the seat`);
  return box;
}

/** Require native CLI success and read its JSON reply. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** File, claim, build and `submit --no-next` one item through the CLI, then wait for its gate receipt to apply; no reviewer command runs. */
async function submitOne(box, mark) {
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Landed page', criterion: 'The page file exists.', args: ['--specs', 'G1'], run: box.runAsync });
  const id = item.item_id;
  document(await box.runAsync(box.web, 'claim', String(id), '--json'));
  const built = helpers.commitFile(box, box.web, 'web/landed.txt', 'landed\n', 'feat(web): landed page [G1]');
  assert.equal(built.status, 0, built.failure ?? built.stderr);
  // The fixture's own settle waits for every job row to read done; a screen is a keyed result, never done, so the gate is awaited below instead.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  try { document(await box.runAsync(box.web, 'submit', String(id), '--no-next', '--json')); } finally { delete box.env.PULLBOARD_FIXTURE_UNSETTLED; }
  mark(`submitted #${id}`);
  await settledGateJob(box, id, { deadlineMs: WAIT_MS });
  mark(`gate receipt applied for #${id}`);
  return { id, commit: box.git(box.web, 'rev-parse', 'HEAD') };
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
  return Number(localRunnerState(fixtureRunnerFolder(box.env))?.heartbeatAt ?? 0);
}

test('cli.sprint.lands-without-accept: clause 1: on a fresh board with pace sprint, after submit --no-next and no reviewer command, show prints merged as and list gives the item a merged commit while it is still submitted [V2,M1,#12177]', { timeout: CASE_MS }, async t => {
  const mark = marker(t);
  const box = pacedProject('sprint', mark);
  const { id } = await submitOne(box, mark);
  const row = await helpers.waitFor(() => { const read = itemRow(box, id); return read.item_merged_commit ? read : null; }, 'the sprint item landed', WAIT_MS); // budget: declared WAIT_MS, the same bound as the gate settle
  mark(`#${id} landed at ${row.item_merged_commit.slice(0, 12)}`);
  const shown = await box.runAsync(box.repo, 'show', String(id), '--no-next');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /^merged as /mu, shown.out);
  const listed = document(await box.runAsync(box.repo, 'list', '--all', '--json')).items.find(item => item.item_id === id);
  assert.match(listed?.item_merged_commit ?? '', /^[0-9a-f]{40}$/u, JSON.stringify(listed));
  assert.equal(listed.item_status, 'submitted', 'no accept was given: the landed item is still submitted');
});

test('cli.sprint.steady-waits-for-accept: clause 2: on a steady board the submitted item does not land without an accept, and lands after one, as today [V2,M1,#12177]', { timeout: CASE_MS }, async t => {
  const mark = marker(t);
  const box = pacedProject('steady', mark);
  const { id, commit } = await submitOne(box, mark);
  // The runner process that applied the receipt beats on a timer: once it beats after the receipt, any landing it started has been offered.
  const applied = Date.now();
  await helpers.waitFor(() => heartbeatAt(box) > applied, 'the local runner heartbeat after the receipt', WAIT_MS); // budget: declared WAIT_MS; the heartbeat is every 5 s
  assert.deepEqual(itemRow(box, id), { item_status: 'submitted', item_merged_commit: null }, 'a steady item does not land without an accept');
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const verdict = await verifySettled(box, box.runAsync, box.repo, ['verify', String(id), 'accept', '--as', 'coordinator', '--note', 'fixture check passed at the submitted commit']);
    assert.equal(verdict.code, 0, verdict.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  mark(`accepted #${id}`);
  const row = await helpers.waitFor(() => { const read = itemRow(box, id); return read.item_merged_commit ? read : null; }, 'the accepted steady item landed', WAIT_MS); // budget: declared WAIT_MS, the same bound as the gate settle
  assert.match(row.item_merged_commit, /^[0-9a-f]{40}$/u, 'the steady item landed after its accept');
});
