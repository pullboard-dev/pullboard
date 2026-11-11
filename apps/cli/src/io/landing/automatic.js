#!/usr/bin/env node
/** An authenticated landing wake holds no foreground lease while it waits [B35,B3,R3]. */
import * as nativeBoard from '../../../../lib/index.js';
import * as outbox from '../../../../../packages/outbox/index.js';
import { context } from '../../../index.js';
import { withBoardRead } from '../../../index.js';
import { landAfterAcceptance } from '../../../index.js';
import { primaryCheckoutRoot } from '../../../index.js';
import { resumeAutomaticLanding } from '../../../../../packages/landing/index.js';
import { scheduleAutomaticLanding } from '../../../../../packages/landing/index.js';
import { automaticLandingDirectory } from '../../../../../packages/landing/index.js';
import {
  retryableLandingRefusal,
  HELD_TRUNK_REFUSALS,
  LANDING_ADOPT_REFUSALS,
  NOTHING_TO_LAND,
  landingWakeTrigger,
  nextLandingBackoff,
  testBlob,
} from '../../../../../packages/landing/index.js';
import { defectStillHolds } from '../../../../../packages/landing/index.js';
import {
  mainCheckout,
  invalidateGitFacts,
  tryGit,
} from '../../../../../packages/git/index.js';
import { stopLandingWaits } from '../../../../../packages/landing/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import {
  landingBatches,
  landingTestDefects,
} from '../../../../../packages/store/index.js';
import { readMainAudit } from '../../../../../packages/gate/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { automaticLandingEnabled } from '../../../../../packages/merge/index.js';
import { setTimeout as pause } from 'node:timers/promises';
import { LANDING_BOARD_BUSY_MS } from '../../../../../packages/landing/index.js';
import { AGENT_SESSION_IDS } from '../../../../../packages/kernel/index.js';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(import.meta.url);

/** The paths whose change at main makes a running lander's code old (#3467). */
const LANDER_CODE = ['apps/cli/src/io/landing/automatic.js', 'packages/landing'];

/**
 * The newest commit at main that changed the lander's own code, or null when this process does not run root's main
 * checkout code or Git cannot say. Why: the scheduler starts root's own apps/cli/src/io/landing/automatic.js, which reads its code
 * from that checkout once, so a later main commit there is code this process never loaded (#3467).
 *
 * @param {string} root - The main checkout.
 * @returns {string | null}
 */
export function landerCodeCommit(root) {
  if (FILE !== join(root, 'apps/cli/src/io/landing/automatic.js')) return null;
  const commit = mainCheckout(root)?.commit;
  const result = commit ? tryGit(root, ['log', '-1', '--format=%H', commit, '--', ...LANDER_CODE]) : null;
  return result?.status === 0 ? result.stdout.trim() || null : null;
}

/** Why a lander that loaded the code of commit `loaded` is older than main's `current`, or null when it is not. */
export function staleLanderReason(loaded, current) {
  return loaded && current && loaded !== current
    ? `lander code ${loaded.slice(0, 12)} is older than main's ${current.slice(0, 12)} (apps/cli/src/io/landing/automatic.js, packages/landing)` : null;
}

/** The lander code commit this process loaded, read on its first wake. */
let loadedCode;

/**
 * The scheduled wake's own io: the outbox, the native board and the board openers the relay path asks for.
 * Why: exported so a test drives landing through exactly the io the wake builds, not a hand-made copy (#2479).
 * A wake run inside a command passes that command's schema-diagnostic set, so a board mismatch the command already
 * reported is not printed a second time by the wake's own board open [A5,C7].
 */
export function wakeIo(root, { schemaDiagnostics } = {}) {
  return { ...outbox, cwd: root, nativeBoard, stdout: process.stdout, stderr: process.stderr,
    ...(schemaDiagnostics ? { schemaDiagnostics } : {}),
    replayConflictRecord: outbox.replay,
    // The lander waits out a seat's long write instead of ending a landing at the board's default 10 s [C7].
    openBoard: (...args) => { const board = nativeBoard.openBoard(...args); board.db.exec(`PRAGMA busy_timeout = ${LANDING_BOARD_BUSY_MS}`); return board; },
    nativeBoardPorts: (...args) => nativeBoard.nativeBoardPorts(...args),
    outboxPolicy: () => ({ acknowledgedOperations: outbox.ACKNOWLEDGED_OPERATIONS, outboxQueueable: outbox.outboxQueueable }),
    // Every lander line carries its time, so a batch's phases read back from worker.log [C7].
    say: (...parts) => console.log(new Date().toISOString(), ...parts), err: (...parts) => console.error(new Date().toISOString(), ...parts) };
}

/** Read current Git and queue facts without retaining a board connection while the worker waits [B35]. */
function landingObservation(root, ioOptions = {}) {
  invalidateGitFacts();
  const ctx = context(wakeIo(root, ioOptions));
  const trunk = mainCheckout(root);
  // A repository with no board has nothing to land; reading must never create one (withBoardRead would open it for write).
  const verified = !existsSync(ctx.file) ? [] : withBoardRead(ctx, board => listItems(board, { all: true })
    .filter(item => item.item_status === 'verified' && !item.item_merged_commit).map(item => `${item.item_id}:${item.item_commit}`).sort());
  return { main: trunk?.commit, branch: trunk?.branch, waiting: verified.length > 0, verified,
    pending: readMainAudit(join(automaticLandingDirectory(root), 'pending.json'))?.id };
}

/**
 * What a backed-off landing watches: each verified, unlanded item with its commit, and the trunk blob of every test file
 * that holds the trunk (a landing test defect whose repair item is still open, claimed or submitted, or a flaky batch on
 * the trunk branch).
 * Why: an accept, a green gate that verifies an item, a commit correcting the held test, a person's landing waiver, or
 * withdrawing or landing the defect's repair item is exactly what can change a held or empty landing's outcome, so each
 * one ends the back-off at once: a defect that stops holding drops its file from the marks, which the wake reads as a
 * held-file change [C7,#3761].
 *
 * @param {string} root - The repository's main checkout.
 * @param {{ schemaDiagnostics?: Set<string> }} [ioOptions]
 * @returns {{ verified: string[], held: Record<string, string | null>, waivers: number } | null} null when the checkout is off its trunk branch
 */
export function landingWakeMarks(root, ioOptions = {}) {
  invalidateGitFacts();
  const ctx = context(wakeIo(root, ioOptions));
  const trunk = mainCheckout(root);
  // A checkout away from its trunk branch says nothing about the trunk; it never wakes a back-off.
  if (!trunk?.branch || !trunk.commit) return null;
  return withBoardRead(ctx, board => {
    const verified = listItems(board, { all: true })
      .filter(item => item.item_status === 'verified' && !item.item_merged_commit).map(item => `${item.item_id}:${item.item_commit}`).sort();
    const files = new Set([
      ...landingTestDefects(board).filter(defect => defect.branch === trunk.branch && defectStillHolds(board, defect)).map(defect => defect.test),
      ...landingBatches(board).filter(batch => batch.state === 'flaky' && batch.branch === trunk.branch).flatMap(batch => (batch.flakes ?? []).map(flake => flake.test)),
    ]);
    const held = Object.fromEntries([...files].sort().map(file => [file, testBlob(root, trunk.commit, file)]));
    // The newest person landing waiver: a new one can release a held trunk, so it wakes a backed-off lander (9 Nov) [C7].
    const waivers = board.db.prepare("SELECT COALESCE(MAX(event_id), 0) AS id FROM event WHERE event_kind = 'landing_waiver'").get().id;
    return { verified, held, waivers };
  });
}

/**
 * Whether a backed-off pending record should be replaced by an immediate wake: an item became verified or a held test
 * file changed since its back-off began. A record with no marks, or a board that cannot be read, keeps its back-off.
 *
 * @param {string} root
 * @param {{ backoff?: { marks?: object } }} job - The pending record.
 * @param {{ schemaDiagnostics?: Set<string>, marks?: typeof landingWakeMarks }} [options]
 * @returns {boolean}
 */
export function landingBackoffWoken(root, job, { schemaDiagnostics, marks = landingWakeMarks } = {}) {
  if (!job?.backoff?.marks) return false;
  try { return landingWakeTrigger(job.backoff.marks, marks(root, { schemaDiagnostics })) !== null; }
  catch { return false; }
}

/**
 * Bootstrap observation for verified work left by an older worker, without replacing a concurrent accept [B35].
 * schemaDiagnostics is the calling command's set of already-reported board mismatches. A backed-off pending record is
 * replaced by an immediate wake when `woken` reports an accept, a green gate or a held-test correction since its back-off
 * began, and is otherwise left to its backed-off timer [C7].
 */
export async function bootstrapLandingWake(root, { schedule = scheduleAutomaticLanding, now = Date.now, schemaDiagnostics, woken = null } = {}) {
  const primary = primaryCheckoutRoot(context(wakeIo(root, { schemaDiagnostics })).info);
  if (!primary) return false;
  const pending = readMainAudit(join(automaticLandingDirectory(primary), 'pending.json'));
  // A backed-off record yields to an accept, a green gate or a held-test correction made since its back-off began [C7].
  if (pending?.backoff) {
    if (!await (woken ?? (job => landingBackoffWoken(primary, job, { schemaDiagnostics })))(pending)) return false;
    return Boolean(await schedule(primary, new Date(now() + 1000).toISOString(), new URL('./automatic.js', import.meta.url),
      { expectedId: pending.id }));
  }
  if (pending) return false;
  const observed = landingObservation(primary, { schemaDiagnostics });
  if (!observed.waiting || !observed.branch || !automaticLandingEnabled(mainPolicy(primary).config)) return false;
  return Boolean(await schedule(primary, new Date(now() + 1000).toISOString(), new URL('./automatic.js', import.meta.url),
    { expectedId: null }));
}

/**
 * Keep authenticated custody while accepted work waits for a main correction, without holding a landing or gate lease.
 * New accepts return to the scheduler's existing due-time/coalescing loop; an unchanged main never hot-retries a refusal.
 * A landing that ends with the trunk held (LAND_TEST_DEFECT, LAND_FLAKE) or that moved nothing backs off: 60 s, doubling
 * up to 5 minutes while the outcome repeats, recorded in the pending record through `onBackoff` and in the next attempt's
 * landing_lease event as backoffMs. While it waits it watches for an item becoming verified (an accept or a green gate)
 * and for a commit changing a held test file on the trunk, and either one wakes the next attempt at once.
 * A lost lease (LAND_LEASE_LOST, LAND_WORKER) reloads within a second, and that wake adopts the batch it left [C7,#5770].
 * Why: on 6 Nov a held trunk restarted a crashing lander on every command, 124 landing leases in 10 minutes [C7].
 */
export async function runLandingWake(root, { land = landAfterAcceptance, wait = pause, pollMs = 5000, now = Date.now, backoff = null,
  onBackoff = async () => {}, marks = landingWakeMarks, codeCommit = landerCodeCommit, loaded, watchMs = 30_000 } = {}) {
  // A lander whose code is older than main's hands over to a fresh one whenever it holds no landing lease: its lease
  // wait releases its place naming the change, and the reload below starts a new worker on main's code (#3467).
  const code = loaded !== undefined ? loaded : (loadedCode ??= codeCommit(root));
  let stale = null;
  let checkedAt = -Infinity;
  const staleCode = () => {
    if (!stale && now() - checkedAt >= watchMs) {
      checkedAt = now();
      try { stale = staleLanderReason(code, codeCommit(root)); } catch { stale = null; }
    }
    return stale;
  };
  // The lease wait asks on each of its own polls, so no timer is needed to see the change while blocked in line.
  stopLandingWaits(staleCode);
  const handover = () => ({ reloadAt: new Date(now() + 1000).toISOString(), workerUrl: new URL('./automatic.js', import.meta.url), handover: stale });
  try { return await wakeOnce(root, { land, wait, pollMs, now, backoff, onBackoff, marks, staleCode, handover }); }
  finally { stopLandingWaits(null); }
}

/** One wake of runLandingWake, which owns the code watch; `staleCode` and `handover` come from it. */
async function wakeOnce(root, { land, wait, pollMs, now, backoff, onBackoff, marks, staleCode, handover }) {
  // The lease the landing takes names the back-off that delayed it.
  if (backoff?.backoffMs) process.env.PULLBOARD_LANDING_BACKOFF_MS = String(backoff.backoffMs);
  else delete process.env.PULLBOARD_LANDING_BACKOFF_MS;
  let observed = landingObservation(root);
  if (!observed.waiting) return;
  const before = observed;
  let held = null, refused = false, ran = null;
  try { ran = await land(context(wakeIo(root))); }
  catch (error) {
    if (error.code === 'LAND_CODE_STALE') return handover();
    // A lost lease keeps its batch: log it and reload, so the next wake adopts the batch and this process exits 0 (#5770).
    if (LANDING_ADOPT_REFUSALS.has(error.code)) {
      console.error(new Date().toISOString(), `landing stopped (${error.code}): ${error.message}; the next wake adopts its batch`);
      return { reloadAt: new Date(now() + 1000).toISOString(), workerUrl: new URL('./automatic.js', import.meta.url) };
    }
    if (HELD_TRUNK_REFUSALS.has(error.code)) {
      held = error.code;
      // The held refusal names what holds the trunk, so a stale hold reads back from worker.log (#3761).
      console.log(new Date().toISOString(), `landing held: ${error.message}`);
    }
    else if (retryableLandingRefusal(error.code)) refused = true;
    else throw error;
  }
  finally { delete process.env.PULLBOARD_LANDING_BACKOFF_MS; }
  if (staleCode()) return handover();
  observed = landingObservation(root);
  if (!observed.waiting) return;
  // A batch that ended blocked with untried work waiting moved the queue: the next run takes that work now, no back-off [C7].
  const moved = observed.main !== before.main || observed.branch !== before.branch
    || observed.verified.join() !== before.verified.join() || ran?.untried === true;
  // A repairable refusal keeps waiting for a main correction below; a held trunk or an empty landing backs off.
  if (held || !refused && !moved) {
    const outcome = held ?? NOTHING_TO_LAND;
    const backoffMs = nextLandingBackoff(backoff, outcome);
    const started = observed, until = now() + backoffMs;
    // Items verified while this landing ran count as new: the back-off compares against the set before it.
    const next = { outcome, backoffMs, retryAt: new Date(until).toISOString(), marks: { ...marks(root), verified: before.verified } };
    await onBackoff(next);
    while (now() < until) {
      await wait(Math.min(pollMs, until - now()));
      if (staleCode()) return handover();
      // The lander's own look comes first: a trigger it sees wakes the next attempt even when a command already rescheduled it.
      if (landingWakeTrigger(next.marks, marks(root))) {
        return { reloadAt: new Date(now() + 1000).toISOString(), workerUrl: new URL('./automatic.js', import.meta.url) };
      }
      observed = landingObservation(root);
      if (!observed.waiting || observed.pending !== started.pending) return;
    }
    return { reloadAt: next.retryAt, workerUrl: new URL('./automatic.js', import.meta.url), backoff: next };
  }
  if (ran?.untried === true) return { reloadAt: new Date(now() + 1000).toISOString(), workerUrl: new URL('./automatic.js', import.meta.url) };
  while (observed.main === before.main && observed.branch === before.branch) {
    if (observed.pending !== before.pending) return;
    await wait(pollMs);
    if (staleCode()) return handover();
    observed = landingObservation(root);
    if (!observed.waiting) return;
  }
  // Reload accepted tooling in a fresh worker; this process may have loaded the code the main correction replaced.
  return { reloadAt: new Date(now() + 1000).toISOString(), workerUrl: new URL('./automatic.js', import.meta.url) };
}

if (process.argv[1] === FILE) {
const [root, token, scheduled, wakeFlag, dueAt] = process.argv.slice(2);
if (!isAbsolute(root ?? '') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')
  || scheduled !== '--scheduled' || wakeFlag !== '--wake-at' || !Number.isFinite(Date.parse(dueAt)) || process.argv.length !== 7) {
  throw new Error('automatic landing requires its registered root, token and wake time');
}
for (const key of [...AGENT_SESSION_IDS, ...AGENT_SHELL_MARKERS, 'PULLBOARD_AGENT', 'PULLBOARD_AGENT_ID', 'PULLBOARD_PARENT_SESSION']) delete process.env[key];
await resumeAutomaticLanding(root, token, dueAt, async (wakeRoot, wake, adopted) => {
  // The replacement records which dead worker's batch it took and how long that batch sat unattended (#2912).
  if (adopted) process.env.PULLBOARD_LANDING_ADOPTION = JSON.stringify(adopted);
  return runLandingWake(wakeRoot, wake);
}, { marks: landingWakeMarks });
// The wake is done: a batch its stop abandoned must not keep running runner jobs and writing to a closed board. Two
// such orphans from 07:28 still ran at 08:40 on 9 Nov, and one logged "could not be recorded: ERR_INVALID_STATE" [C7].
process.exit(process.exitCode ?? 0);

}
