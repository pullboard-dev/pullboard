/**
 * Settle a fixture's pulled submit: a pull submit returns "queued" at once and the machine's local runner pulls the gate
 * job on loopback, so a journey that asserts the gate result waits here for the job's receipt [P7,C7,#6249].
 *
 * Why one helper: controller dispatch, which held the gate inside the submitting process, is going (#5821). Journeys read
 * a settled gate the same way through this one seam instead of pinning gate.runnerDispatch file by file. It reads the gate
 * through `pullboard show --json`, the CLI the fixture already drives, so no journey reaches into the jobs cell.
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from 'node:fs';
import { reviveFixtureLocalRunner } from '../runner/local-start.js';

/** The tail of the machine's local runner log, so a gate that never settles shows what the runner saw. */
function runnerLog(machineHome) {
  const log = join(machineHome ?? '', 'local-runner', 'runner.log');
  return machineHome && existsSync(log) ? readFileSync(log, 'utf8').slice(-3000) : '(no local runner log)';
}

/** True when the thread holds the fact applyGateReceipt writes for a gate job's result; the earlier "offered for" note is not one. */
function resultFact(thread, jobId) {
  const text = JSON.stringify(thread ?? []);
  return Boolean(jobId) && (text.includes(`Gate job ${jobId} red at `) || text.includes(`Gate job ${jobId} passed but not submitted`));
}

/**
 * Wait until `show --json` names the item's newest gate job as done AND the board has applied its receipt, read again on
 * every change to the local runner's folder (a log line per claim and receipt, a heartbeat every 5 s); refuses with the
 * runner log after deadlineMs. Why the runner's folder: the show read itself touches the board's folder and would wake
 * the wait again. Why the receipt too: the board marks the job row done before applyGateReceipt moves the item, so a
 * test that acts on the job row alone (verify accept) races and fails NOT_SUBMITTED on a loaded runner [C7,#7283]. The
 * receipt is applied once the item has left `claimed` (submitted, or stale) or the thread names the job's gate result
 * fact; a job done but not yet applied is read again on the runner's next log line or 5 s heartbeat.
 *
 * @param {{ repo: string, env: object, run: Function }} box - The fixture project; run(cwd, ...args) returns, or resolves to,
 *   { code, out, err }.
 * @param {number} item - The submitted item.
 * @param {{ deadlineMs?: number, until?: (shown: object) => boolean }} [options] - until: a further condition on the
 *   shown item once the job is done, such as a red that settles only after main's receipts record.
 * @returns {Promise<{ id: string, step: string, gate: object | null }>} The done gate job as show prints it.
 */
export function settledGateJob(box, item, { deadlineMs = 180_000, until = () => true } = {}) {
  const machineHome = box.env.PULLBOARD_MACHINE_HOME;
  return new Promise((done, fail) => {
    let watcher = null, last = '', step = 'none', settled = false, reading = false, again = false;
    const stop = () => { settled = true; watcher?.close(); clearTimeout(timer); };
    /** Read show once; a change that lands mid-read asks for one more read after it. */
    const probe = async () => {
      if (settled) return;
      if (reading) { again = true; return; }
      reading = true;
      let job = null, doc = null, applied = false;
      try {
        const shown = await box.run(box.repo, 'show', String(item), '--json', '--no-next');
        last = shown.out || shown.err || '';
        doc = shown.code === 0 ? JSON.parse(shown.out) : null;
        job = doc?.gateJob ?? null;
        // A red gate leaves the item claimed and records its "Gate job <id> red|passed but not submitted" fact; a green or stale one moves it on.
        applied = Boolean(doc) && (doc.item_status !== 'claimed' || resultFact(doc.thread, job?.id));
      } catch { /* a partial read; the next change reads again */ } finally { reading = false; }
      step = job?.step ?? 'none';
      if (step === 'done' && applied && until(doc) && !settled) { stop(); done(job); return; }
      if (again) { again = false; await probe(); }
    };
    const timer = setTimeout(() => { stop(); fail(new Error(`gate for #${item} did not settle in ${deadlineMs} ms (last step ${step})\nlast show: ${last.slice(0, 600)}\nlocal runner log:\n${runnerLog(machineHome)}`)); }, deadlineMs);
    try { watcher = watch(join(machineHome, 'local-runner'), () => { probe(); }); } catch (error) { stop(); fail(new Error(`gate for #${item} is queued but this machine has no local runner: ${error.message}`)); return; }
    probe();
  });
}

/**
 * Settle a submit's result: an inline gate result comes back as is; a queued one waits for the gate job to finish and
 * comes back with its receipt's gate under `gate`, the shape an inline submit printed. The local runner is stopped when
 * the test ends, so no fixture leaves a runner behind.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ repo: string, env: object, run: Function }} box - The fixture project.
 * @param {object} submitted - The submit's parsed --json document.
 * @param {{ deadlineMs?: number }} [options]
 * @returns {Promise<object>} The submit document with `gate` from the pulled gate and `gateJob`.
 */
export async function settleSubmit(t, box, submitted, options) {
  if (!submitted?.queued) return submitted;
  const pid = submitted.localRunner?.pid;
  if (pid) t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  // A relay-linked checkout or a stopped runner (a gate switch, runnerSwitchedEnv) starts none of its own [P7,#5821].
  reviveFixtureLocalRunner(box.repo, box.env);
  const gateJob = await settledGateJob(box, submitted.item ?? submitted.id, options);
  return { ...submitted, gate: gateJob.gate, gateJob };
}
