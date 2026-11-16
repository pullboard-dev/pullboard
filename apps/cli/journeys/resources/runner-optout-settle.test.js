/** @pullboard-test-input source-cell apps/cli packages/gate */
/** Isolates the opt-out half of the runner-only case: after the policy turns runnersOnly off, does the gate job of a --wait submit ever settle [C7,Q1,V4,#9398]? */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { whenRunnerSettles } from '../../tests/fixtures/runner/local-start.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

// Budget: how long the opt-out submit's gate job has to settle before the failure names where it stands.
const SETTLE_MS = 30_000;

/** Write only the machine policy the case needs, keeping the rest of the settings native setup produced. */
function policy(box, runnersOnly) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...previous, gateSlots: 1, browserSlots: 1, gate: { ...previous.gate, runnersOnly, runnerWaitMs: 80 } }));
}

/** Every job row of the fixture board, read-only, oldest first; a locked board reads as no rows this time. */
function jobRows(box) {
  // @pullboard-board-file journey: a read-only look at the gate job the real CLI queued, to name its step and lease holder.
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until FROM job ORDER BY job_created').all().map(row => ({ ...row })); } finally { db.close(); }
  } catch { return []; }
}

/** The last 40 lines of the machine's local runner log, or a note that it has none. */
function runnerTail(box) {
  const log = join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'runner.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(-40).join('\n') : '(no local runner log)';
}

/** The item's newest gate job row, or null when none is queued. */
function newestGateJob(box, item) {
  return jobRows(box).filter(row => row.job_kind === 'gate' && Number(row.job_item) === Number(item)).at(-1) ?? null;
}

/** The item's gate job once its step is done, or whatever stands at the budget: read on every change to the local runner's folder, never on a timer. */
async function gateJobWithin(box, item) {
  try {
    return await whenRunnerSettles(box.env, () => { const job = newestGateJob(box, item); return job?.job_step === 'done' ? job : null; }, { deadlineMs: SETTLE_MS, what: `the opt-out gate job of #${item}` });
  } catch { return newestGateJob(box, item); }
}

test('clause 1: after runnersOnly turns off, the submit --wait gate job settles, or the failure names its job_step, job_lease_owner and the runner log tail at 30 s [C7,Q1,V4]', async () => {
  const box = helpers.project('true');
  const marker = join(box.dir, 'submit-frozen-body');
  const command = `printf ran > '${marker.replaceAll("'", "'\\\\''")}'`;
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Private runner-only opt-out', '--specs', 'G1', '--criterion', 'The native frozen check remains mandatory.', '--check', command, '--wait', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, `${claimed.err}\n${claimed.out}`);
  const committed = helpers.commitFile(box, box.web, 'web/runner-only.js', 'export const ready = true;\n', 'feat(web): private runner-only control [G1]');
  assert.equal(committed.status, 0, committed.failure ?? committed.stderr);
  // Real processes for both submits: an in-process call would keep the machine settings it read first, and the policy change would never reach it.
  // Native bar baseline setup may itself have run the command; it is not the subject submission.
  rmSync(marker, { force: true });
  policy(box, true);
  const refused = await box.runAsync(box.web, 'submit', String(id), '--wait', '--no-next', '--json');
  assert.notEqual(refused.code, 0, refused.out);
  assert.equal(JSON.parse(refused.out).error.code, 'RUNNER_WAIT_DEADLINE', refused.err || refused.out);
  policy(box, false);
  // The fixture's own settle wait is off for this one call, so the case reads the job itself and a hang shows its state at 30 s instead of at 180 s.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  const submitting = box.runAsync(box.web, 'submit', String(id), '--wait', '--no-next', '--json');
  const job = await gateJobWithin(box, id);
  const evidence = `job_step=${job?.job_step ?? 'none'} job_lease_owner=${job?.job_lease_owner ?? 'none'} jobs=${JSON.stringify(jobRows(box))}\nlocal runner log (last 40 lines):\n${runnerTail(box)}`;
  console.log(`# opt-out gate job at the check: ${evidence}`);
  assert.equal(job?.job_step, 'done', `the opt-out gate job did not settle in ${SETTLE_MS} ms\n${evidence}`);
  await submitting;
});
