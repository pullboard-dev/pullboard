#!/usr/bin/env node
/** An authenticated landing wake holds no foreground lease while it waits [B35,B3,R3]. */
import * as nativeBoard from '../../../../lib/index.js';
import * as outbox from '../../../../../packages/outbox/index.js';
import { context } from '../../../index.js';
import { withBoardRead } from '../../../index.js';
import { landAfterAcceptance } from '../../../index.js';
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
import { sprintLandable } from '../../../../../packages/api/index.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';
import {
  landingBatches,
  landingTestDefects,
} from '../../../../../packages/store/index.js';
import { setTimeout as pause } from 'node:timers/promises';
import { LANDING_BOARD_BUSY_MS } from '../../../../../packages/landing/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fs = fileSystemAdapter();

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
const environment = environmentAdapter();

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
    // Every lander line carries its time, so a batch's phases read back from its log [C7].
    say: (...parts) => console.log(new Date().toISOString(), ...parts), err: (...parts) => console.error(new Date().toISOString(), ...parts) };
}

/** Read current Git and queue facts without retaining a board connection while the worker waits [B35]. */
function landingObservation(root, ioOptions = {}) {
  invalidateGitFacts();
  const ctx = context(wakeIo(root, ioOptions));
  const trunk = mainCheckout(root);
  // A repository with no board has nothing to land; reading must never create one (withBoardRead would open it for write).
  const verified = !fs.exists(ctx.file) ? [] : withBoardRead(ctx, board => listItems(board, { all: true })
    .filter(item => !item.item_merged_commit && (item.item_status === 'verified' || sprintLandable(board, item, trunk?.commit ?? null))).map(item => `${item.item_id}:${item.item_commit}`).sort());
  return { main: trunk?.commit, branch: trunk?.branch, waiting: verified.length > 0, verified };
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
  if (backoff?.backoffMs) environment.set('PULLBOARD_LANDING_BACKOFF_MS', String(backoff.backoffMs));
  else environment.delete('PULLBOARD_LANDING_BACKOFF_MS');
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
      // The held refusal names what holds the trunk, so a stale hold reads back from the lander's log (#3761).
      console.log(new Date().toISOString(), `landing held: ${error.message}`);
    }
    else if (retryableLandingRefusal(error.code)) refused = true;
    else throw error;
  }
  finally { environment.delete('PULLBOARD_LANDING_BACKOFF_MS'); }
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
    const until = now() + backoffMs;
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
      if (!observed.waiting) return;
    }
    return { reloadAt: next.retryAt, workerUrl: new URL('./automatic.js', import.meta.url), backoff: next };
  }
  if (ran?.untried === true) return { reloadAt: new Date(now() + 1000).toISOString(), workerUrl: new URL('./automatic.js', import.meta.url) };
  while (observed.main === before.main && observed.branch === before.branch) {
    await wait(pollMs);
    if (staleCode()) return handover();
    observed = landingObservation(root);
    if (!observed.waiting) return;
  }
  // Reload accepted tooling in a fresh worker; this process may have loaded the code the main correction replaced.
  return { reloadAt: new Date(now() + 1000).toISOString(), workerUrl: new URL('./automatic.js', import.meta.url) };
}
