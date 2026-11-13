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

/** The tail of the machine's local runner log, so a gate that never settles shows what the runner saw. */
function runnerLog(machineHome) {
  const log = join(machineHome ?? '', 'local-runner', 'runner.log');
  return machineHome && existsSync(log) ? readFileSync(log, 'utf8').slice(-3000) : '(no local runner log)';
}

/**
 * Wait until `show --json` names the item's newest gate job as done, read again on every change to the local runner's
 * folder (a log line per claim and receipt, a heartbeat every 5 s); refuses with the runner log after deadlineMs.
 * Why the runner's folder: the show read itself touches the board's folder and would wake the wait again.
 *
 * @param {{ repo: string, env: object, run: Function }} box - The fixture project.
 * @param {number} item - The submitted item.
 * @param {{ deadlineMs?: number }} [options]
 * @returns {Promise<{ id: string, step: string, gate: object | null }>} The done gate job as show prints it.
 */
export function settledGateJob(box, item, { deadlineMs = 180_000 } = {}) {
  const machineHome = box.env.PULLBOARD_MACHINE_HOME;
  return new Promise((done, fail) => {
    let watcher = null, last = '', step = 'none', settled = false;
    const stop = () => { settled = true; watcher?.close(); clearTimeout(timer); };
    const probe = () => {
      if (settled) return true;
      const shown = box.run(box.repo, 'show', String(item), '--json', '--no-next');
      last = shown.out || shown.err;
      let job = null;
      try { job = shown.code === 0 ? JSON.parse(shown.out).gateJob ?? null : null; } catch { /* a partial read; the next change reads again */ }
      step = job?.step ?? 'none';
      if (step !== 'done') return false;
      stop();
      done(job);
      return true;
    };
    const timer = setTimeout(() => { stop(); fail(new Error(`gate for #${item} did not settle in ${deadlineMs} ms (last step ${step})\nlast show: ${last.slice(0, 600)}\nlocal runner log:\n${runnerLog(machineHome)}`)); }, deadlineMs);
    if (probe()) return;
    try { watcher = watch(join(machineHome, 'local-runner'), probe); } catch (error) { stop(); fail(new Error(`gate for #${item} is queued but this machine has no local runner: ${error.message}`)); }
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
  const gateJob = await settledGateJob(box, submitted.item ?? submitted.id, options);
  return { ...submitted, gate: gateJob.gate, gateJob };
}
