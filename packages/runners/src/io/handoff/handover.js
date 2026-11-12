/** The hand-off dispatcher's hand-over to current tooling and its per-pass work, behind the runners front door [C7,DJ16]. */
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { basename } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from '../../../../kernel/index.js';
import { HANDOFF_DISPATCHER_OWNER_ENV } from '../../../../resources/index.js';
import { ensureHandoffDispatcher } from '../../../../resources/index.js';
import { finishRunningWorkers } from '../../../../resources/index.js';
import { handoffQueueDirectory } from '../../../../resources/index.js';
import { releaseLifelines } from '../../../../resources/index.js';

/** The tools folder a dispatcher in this tree runs from. */
const OWN_TOOLS = fileURLToPath(new URL('../../../../..', import.meta.url));

/** How often a dispatcher checks that it runs its tool root's current tooling; the check runs git, so not every pass. */
const TOOLS_CHECK_MS = 30_000;

/** The launches waiting in line, as their tickets name them; unreadable tickets are left to the drain to report. */
function waitingLaunches() {
  let names;
  try { names = readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.json$/u.test(name)).sort(); }
  catch { return []; }
  const launches = [];
  for (const name of names) {
    try { launches.push(JSON.parse(readFileSync(join(handoffQueueDirectory(), name), 'utf8'))); }
    catch { /* the drain reports a ticket it cannot read */ }
  }
  return launches;
}

/** A shared tools snapshot's folder name: one per tooling tree. */
const SHARED_TOOLS = /^pullboard-handoff-tools-[0-9a-f]{40}$/u;

/**
 * The current tools this dispatcher should hand over to, or null while it runs them. The newest waiting launch whose
 * request was captured at the commit `head` names for its tool root (main's tip) names the current tooling snapshot; a
 * dispatcher running a different shared snapshot hands over to it. A dispatcher run from a checkout, or with no launch
 * captured at that commit, never hands over.
 *
 * Why: on 8 Nov a dispatcher started from submit-time tools kept launching gates on code main had fixed (no
 * PROOF_MAX_SHARDS), and one gate opened 18 runner controllers; one live dispatcher must run main's tooling (DJ16).
 *
 * @param {{ own?: string, launches?: () => { directory: string, tools: string }[], head: (root: string) => string | null }} ports - `head` names a tool root's current tooling commit, its trunk tip, so a seat worktree's item HEAD never counts; it runs git, which this cell's lease-reached modules never do synchronously, so the caller passes it in.
 * @returns {string | null} The current tools folder to hand over to.
 */
export function staleDispatcherTools({ own = OWN_TOOLS, launches = waitingLaunches, head } = {}) {
  if (typeof head !== 'function') throw new Refused('DISPATCHER_TOOLS_HEAD', 'pass the function that names a tool root\'s HEAD commit');
  if (!SHARED_TOOLS.test(basename(own))) return null;
  for (const launch of [...launches()].reverse()) {
    let request;
    try { request = JSON.parse(readFileSync(join(launch.directory, 'request.json'), 'utf8')); } catch { continue; }
    if (typeof request.toolRoot !== 'string' || typeof launch.tools !== 'string' || !SHARED_TOOLS.test(basename(launch.tools))) continue;
    if (!existsSync(launch.tools) || request.toolsCommit !== head(request.toolRoot)) continue;
    try { return realpathSync(launch.tools) === realpathSync(own) ? null : launch.tools; } catch { return null; }
  }
  return null;
}

/** How often a dispatcher pass looks for gate verdicts waiting on main: the row's own renewal cadence. */
const VERDICT_PASS_MS = 5_000;

/**
 * Build the dispatcher's per-pass work: renew its row, and at most every VERDICT_PASS_MS run `finish` on the row's
 * board, which finishes every gate verdict waiting on main whose main-test jobs have returned. Why: a verdict that
 * waits on main is a board row, not a waiting process; the drive loop finishes it, so no item goes back to its builder
 * for a red main owns [C7,#3534]. The finishing belongs to the gate and drive cells, so the caller passes it in.
 *
 * @param {{ renew: () => (boolean | void), withDb: Function }} row - This dispatcher's job row.
 * @param {{ finish: (db: object) => void, stale: () => string | null, now?: () => number }} ports
 * @returns {() => void}
 */
export function dispatcherPass(row, { finish, stale, now = Date.now } = {}) {
  if (typeof finish !== 'function' || typeof stale !== 'function') throw new Refused('DISPATCHER_PASS_PORTS', 'pass the verdict finisher and the stale-tools check the dispatcher runs each pass');
  let lookedAt = 0;
  let toolsAt = 0;
  return () => {
    // Another dispatcher took the row: stop launching at once and leave the machine to it (DJ16).
    if (row.renew() === false) throw Object.assign(new Error('another dispatcher holds the dispatcher row'), { code: 'DISPATCHER_REPLACED', tools: null, handOver: true });
    if (now() - toolsAt >= TOOLS_CHECK_MS) {
      toolsAt = now();
      const tools = stale();
      // Stop launching: the drain frees the machine's lock on the way out, and the dispatcher hands over to these tools.
      if (tools) throw Object.assign(new Error(`this dispatcher runs ${OWN_TOOLS}; current tooling is ${tools}`), { code: 'DISPATCHER_TOOLS_STALE', tools, handOver: true });
    }
    if (now() - lookedAt < VERDICT_PASS_MS) return;
    lookedAt = now();
    row.withDb(db => finish(db));
  };
}

/** One timestamped line on the dispatcher's stderr, which is its log. */
function logLine(line) { process.stderr.write(`${new Date().toISOString()} ${line}\n`); }

/** The signals a handed-over dispatcher records before it ends, so the next death names its cause. */
const RECORDED_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'];

/**
 * While a handed-over dispatcher waits on its gates, record any stop signal it receives and how many gates still run,
 * then exit as the signal would. Returns the call that removes the handlers.
 * Why: on 11 Nov two handed-over dispatchers ended with nothing in their log; the cause could not be named [C7].
 *
 * @param {Map<unknown, object>} running
 * @param {(code: number) => void} exit
 * @returns {() => void}
 */
export function recordStopSignals(running, exit) {
  const handlers = RECORDED_SIGNALS.map(signal => {
    const handler = () => {
      logLine(`handed-over dispatcher ${process.pid} received ${signal} with ${running.size} gate driver(s) still running; they finish on their own`);
      exit(128 + constants.signals[signal]);
    };
    process.once(signal, handler);
    return () => process.off(signal, handler);
  });
  return () => { for (const remove of handlers) remove(); };
}

/**
 * Hand the machine over, then exit once the gates this dispatcher started have finished. First each running gate's
 * driver is told it is handed over, so it finishes its gate even if this process dies before it. With current tools,
 * launch one from them in this directory under this dispatcher's own row owner, so the successor holds the row it
 * renewed; with none, another dispatcher already took the row. Either way this one launches nothing more and frees
 * each of its workers' slots as they exit (DJ16).
 *
 * @param {string | null} tools - The current tools folder, or null when another dispatcher took over.
 * @param {(code: number) => void} exit
 * @param {{ launch?: typeof ensureHandoffDispatcher, running?: Map<unknown, object>, finish?: typeof finishRunningWorkers, release?: typeof releaseLifelines, signals?: typeof recordStopSignals, owner?: string, startOf?: (pid: number) => string }} [ports]
 */
export async function handOver(tools, exit, { launch = ensureHandoffDispatcher, running = new Map(), finish = finishRunningWorkers, release = releaseLifelines, signals = recordStopSignals, owner = process.env[HANDOFF_DISPATCHER_OWNER_ENV], startOf } = {}) {
  const stopRecording = signals(running, exit);
  let released = 0;
  try { released = await release(running); }
  catch (error) { logLine(`gate drivers not told of the hand-over: ${error.message}; they stop when this dispatcher exits`); }
  const line = tools ? `dispatcher on ${OWN_TOOLS} hands over to current tooling ${tools}` : `dispatcher on ${OWN_TOOLS} stops: another dispatcher took the row`;
  // The dispatcher's stderr is its log, so the hand-over is recorded there.
  logLine(`${line}; ${released} running gate driver(s) finish on their own`);
  if (tools) {
    try { await launch(tools, process.cwd(), { ...(startOf ? { startOf } : {}), ...(owner ? { owner } : {}) }); }
    catch (error) { process.stderr.write(`hand-over launch failed: ${error.message}; the next submit launches a dispatcher\n`); }
  }
  await finish(running);
  stopRecording();
  logLine(`handed-over dispatcher ${process.pid} exits: its gate drivers finished`);
  exit(0);
}
