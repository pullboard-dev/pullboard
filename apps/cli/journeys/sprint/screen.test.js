/** A submitted sprint item gets a green screen job from the starter `pullboard serve` hands the board, with no accept; a steady item gets none [V2,M1,#12175]. */
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

const helpers = createE2eHelpers();
after(helpers.cleanup);
// Budget: each CLI step, and the screen after the gate, must end well inside the file's kill.
const WAIT_MS = 40_000;
// Budget: declared per case, so one stuck case ends with its step diagnostics inside the file's kill.
const CASE_MS = 80_000;

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
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Screened page', criterion: 'The page file exists.', args: ['--specs', 'G1'], run: box.runAsync });
  const id = item.item_id;
  mark(`filed #${id}`);
  document(await box.runAsync(box.web, 'claim', String(id), '--json'));
  mark(`claimed #${id}`);
  const built = helpers.commitFile(box, box.web, 'web/screened.txt', 'screened\n', 'feat(web): screened page [G1]');
  assert.equal(built.status, 0, built.failure ?? built.stderr);
  // The fixture's own settle waits for every job row to read done; a screen is a keyed result, never done, so the gate is awaited below instead.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  try { document(await box.runAsync(box.web, 'submit', String(id), '--no-next', '--json')); } finally { delete box.env.PULLBOARD_FIXTURE_UNSETTLED; }
  mark(`submitted #${id}`);
  await settledGateJob(box, id, { deadlineMs: WAIT_MS });
  mark(`gate receipt applied for #${id}`);
  return id;
}

/** Every screen job on the board with its stored result (null until one is written), the kinds of the item's jobs and its status, read-only. */
function screens(box, id) {
  // @pullboard-board-file journey: a read-only look at the jobs the real CLI and its runner wrote.
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const jobs = db.prepare("SELECT j.job_id AS id, s.job_step_payload AS payload FROM job j LEFT JOIN job_step s ON s.job_step_job = j.job_id AND s.job_step_name = 'result' WHERE j.job_kind = 'screen' ORDER BY j.job_id").all();
    return {
      jobs: jobs.map(row => ({ id: row.id, result: row.payload ? JSON.parse(row.payload).result ?? null : null })),
      kinds: db.prepare('SELECT DISTINCT job_kind AS kind FROM job WHERE job_item = ? ORDER BY job_kind').all(id).map(row => row.kind),
      status: db.prepare('SELECT item_status AS status FROM item WHERE item_id = ?').get(id)?.status,
    };
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

test('cli.sprint.screen-on-submit: clause 1: on a fresh board with pace sprint, a claimed, built item submitted with submit --no-next gets exactly one green screen job with no accept given [V2,M1,#12175]', { timeout: CASE_MS }, async t => {
  const mark = marker(t);
  const box = pacedProject('sprint', mark);
  const id = await submitOne(box, mark);
  const seen = await helpers.waitFor(() => { const read = screens(box, id); return read.jobs.some(job => job.result) ? read : null; }, 'a stored screen result', WAIT_MS); // budget: declared WAIT_MS, the same bound as the gate settle
  assert.equal(seen.jobs.length, 1, `exactly one screen job: ${JSON.stringify(seen.jobs)}`);
  const [{ result }] = seen.jobs;
  assert.equal(result.kind, 'screen', JSON.stringify(result));
  assert.equal(result.item, id, 'the screen is the submitted item\'s');
  assert.equal(result.green, true, `the screen is green: ${JSON.stringify(result)}`);
  assert.equal(seen.status, 'submitted', 'no accept was given: the item is still submitted');
});

test('cli.sprint.screen-steady-none: clause 2: the same journey on a steady board makes no screen job, and the item keeps its gate job as today [V2,M1,#12175]', { timeout: CASE_MS }, async t => {
  const mark = marker(t);
  const box = pacedProject('steady', mark);
  const id = await submitOne(box, mark);
  // The runner process that applied the receipt beats on a timer: once it beats after the receipt, any screen it started has begun.
  const applied = Date.now();
  await helpers.waitFor(() => heartbeatAt(box) > applied, 'the local runner heartbeat after the receipt', WAIT_MS); // budget: declared WAIT_MS; the heartbeat is every 5 s
  const seen = screens(box, id);
  assert.deepEqual(seen.jobs, [], 'a steady board never sees a screen job');
  assert.ok(seen.kinds.includes('gate'), `the item's gate job is there as today: ${seen.kinds.join(', ')}`);
  assert.equal(seen.status, 'submitted');
});
