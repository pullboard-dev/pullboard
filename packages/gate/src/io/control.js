/**
 * Gate runs and their positive controls [C7,D1]. Every real gate run appends one line to the checkout's git
 * directory; health reads those lines. A gate that refuses every run in its window, or whose known-good case
 * (the project's positiveControl) fails, is an alarm: it can no longer prove that it can pass.
 */
import { gitPath } from '../../../git/index.js';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

/** The append-only record of real gate runs, kept in the git directory so it never enters a commit. */
export const GATE_RUNS_FILE = 'pullboard-gate-runs.jsonl';
/** How far back a run counts toward "refused every run": one day. */
export const GATE_WINDOW_MS = 86_400_000;
/** The fewest refused runs in the window that make a refusal an alarm, so one bad run is not news. */
export const GATE_MIN_RUNS = 3;
/** How many of the last runs an alarm carries, so its reader sees the pattern without opening the log. */
const LAST_RUNS = 5;

/**
 * Append one real gate run to the record. A run that the environment refused is not a gate result, so the
 * caller leaves it out.
 *
 * @param {string} root the checkout whose gate ran
 * @param {{ at: string, green: boolean, control: boolean | null, gate: string, positiveControl: string | null }} run
 */
export function recordGateRun(root, run) {
  fs.appendFile(gitPath(root, GATE_RUNS_FILE), `${JSON.stringify(run)}\n`);
}

/**
 * Read every recorded gate run, oldest first. A missing file is no runs yet; a torn or foreign line is skipped,
 * since one bad line must not hide the rest of the record.
 *
 * @param {string} root
 * @returns {Array<{ at: string, green: boolean, control: boolean | null, gate: string, positiveControl: string | null }>}
 */
export function gateRuns(root) {
  const file = gitPath(root, GATE_RUNS_FILE);
  if (!fs.exists(file)) return [];
  return fs.readFile(file, 'utf8').split('\n').flatMap((line) => {
    try {
      const run = JSON.parse(line);
      return run && typeof run.at === 'string' && typeof run.green === 'boolean' ? [run] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The gate alarms health reports: the last gate run's positive control failed, or every run in the window was
 * refused (at least GATE_MIN_RUNS of them). Each carries the gate, its control and its last runs; neither ever
 * reads as green.
 *
 * @param {string} root
 * @param {{ gate?: string, positiveControl?: string }} config
 * @param {Date} now
 * @returns {Array<object>} findings in the shape health reports
 */
export function gateControlFindings(root, config, now) {
  const runs = gateRuns(root);
  if (!runs.length) return [];
  const lastRuns = runs.slice(-LAST_RUNS);
  const detail = { gate: config.gate ?? '', positiveControl: config.positiveControl ?? null, runs: lastRuns };
  const alarms = [];
  const last = runs.at(-1);
  if (last.control === false) {
    alarms.push({
      key: 'GATE_CONTROL_FAILED:gate', cause: 'GATE_CONTROL_FAILED', item: null, subject: 'gate',
      title: 'gate positive control failed', since: last.at,
      why: `the gate's positive control "${config.positiveControl}" failed on its last run, so the gate can no longer be trusted to pass a good change`,
      next: 'fix the known-good case named by positiveControl in pullboard.json, or the gate it proves',
      command: null, owner: { role: 'coordinator', who: 'coordinator' }, detail,
    });
  }
  const windowStart = now.getTime() - GATE_WINDOW_MS;
  const recent = runs.filter((run) => Date.parse(run.at) >= windowStart);
  if (recent.length >= GATE_MIN_RUNS && recent.every((run) => !run.green)) {
    alarms.push({
      key: 'GATE_REFUSED_EVERY_RUN:gate', cause: 'GATE_REFUSED_EVERY_RUN', item: null, subject: 'gate',
      title: 'gate refused every run', since: recent[0].at,
      why: `the gate refused all ${recent.length} runs in the last day, so it refuses everything and proves nothing`,
      next: 'run pullboard gate and fix the failure it names, or check the gate command in pullboard.json',
      command: 'pullboard gate', owner: { role: 'coordinator', who: 'coordinator' }, detail,
    });
  }
  return alarms.map((alarm) => ({ ...alarm, ageMinutes: Math.max(0, Math.floor((now.getTime() - Date.parse(alarm.since)) / 60_000)) }));
}
