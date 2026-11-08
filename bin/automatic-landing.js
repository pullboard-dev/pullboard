#!/usr/bin/env node
/** An authenticated landing wake holds no foreground lease while it waits [B35,B3,R3]. */
import * as nativeBoard from '../apps/lib/index.js';
import * as outbox from '../packages/outbox/index.js';
import { context } from '../apps/cli/index.js';
import { withBoardRead } from '../apps/cli/index.js';
import { landAfterAcceptance } from '../apps/cli/index.js';
import { primaryCheckoutRoot } from '../apps/cli/index.js';
import { resumeAutomaticLanding } from '../packages/landing/index.js';
import { scheduleAutomaticLanding } from '../packages/landing/index.js';
import { automaticLandingDirectory } from '../packages/landing/index.js';
import { retryableLandingRefusal, HELD_TRUNK_REFUSALS, NOTHING_TO_LAND, landingWakeTrigger, nextLandingBackoff, testBlob } from '../packages/landing/index.js';
import { mainCheckout, invalidateGitFacts } from '../packages/git/index.js';
import { listItems } from '../packages/store/index.js';
import { landingBatches, landingTestDefects } from '../packages/store/index.js';
import { readMainAudit } from '../packages/gate/index.js';
import { mainPolicy } from '../packages/sandbox/index.js';
import { automaticLandingEnabled } from '../packages/merge/index.js';
import { setTimeout as pause } from 'node:timers/promises';
import { LANDING_BOARD_BUSY_MS } from '../packages/landing/index.js';
import { AGENT_SESSION_IDS } from '../packages/kernel/index.js';
import { AGENT_SHELL_MARKERS } from '../packages/kernel/index.js';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(import.meta.url);

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
  const verified = withBoardRead(ctx, board => listItems(board, { all: true })
    .filter(item => item.item_status === 'verified' && !item.item_merged_commit).map(item => `${item.item_id}:${item.item_commit}`).sort());
  return { main: trunk?.commit, branch: trunk?.branch, waiting: verified.length > 0, verified,
    pending: readMainAudit(join(automaticLandingDirectory(root), 'pending.json'))?.id };
}

/**
 * What a backed-off landing watches: each verified, unlanded item with its commit, and the trunk blob of every test file
 * that holds the trunk (a landing test defect or a flaky batch on the trunk branch).
 * Why: an accept, a green gate that verifies an item, or a commit correcting the held test is exactly what can change a
 * held or empty landing's outcome, so each one ends the back-off at once [C7].
 *
 * @param {string} root - The repository's main checkout.
 * @param {{ schemaDiagnostics?: Set<string> }} [ioOptions]
 * @returns {{ verified: string[], held: Record<string, string | null> } | null} null when the checkout is off its trunk branch
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
      ...landingTestDefects(board).filter(defect => defect.branch === trunk.branch).map(defect => defect.test),
      ...landingBatches(board).filter(batch => batch.state === 'flaky' && batch.branch === trunk.branch).flatMap(batch => (batch.flakes ?? []).map(flake => flake.test)),
    ]);
    const held = Object.fromEntries([...files].sort().map(file => [file, testBlob(root, trunk.commit, file)]));
    return { verified, held };
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
    return Boolean(await schedule(primary, new Date(now() + 1000).toISOString(), new URL('./automatic-landing.js', import.meta.url),
      { expectedId: pending.id }));
  }
  if (pending) return false;
  const observed = landingObservation(primary, { schemaDiagnostics });
  if (!observed.waiting || !observed.branch || !automaticLandingEnabled(mainPolicy(primary).config)) return false;
  return Boolean(await schedule(primary, new Date(now() + 1000).toISOString(), new URL('./automatic-landing.js', import.meta.url),
    { expectedId: null }));
}

/**
 * Keep authenticated custody while accepted work waits for a main correction, without holding a landing or gate lease.
 * New accepts return to the scheduler's existing due-time/coalescing loop; an unchanged main never hot-retries a refusal.
 * A landing that ends with the trunk held (LAND_TEST_DEFECT, LAND_FLAKE) or that moved nothing backs off: 60 s, doubling
 * up to 5 minutes while the outcome repeats, recorded in the pending record through `onBackoff` and in the next attempt's
 * landing_lease event as backoffMs. While it waits it watches for an item becoming verified (an accept or a green gate)
 * and for a commit changing a held test file on the trunk, and either one wakes the next attempt at once.
 * Why: on 6 Nov a held trunk restarted a crashing lander on every command, 124 landing leases in 10 minutes [C7].
 */
export async function runLandingWake(root, { land = landAfterAcceptance, wait = pause, pollMs = 5000, now = Date.now, backoff = null,
  onBackoff = async () => {}, marks = landingWakeMarks } = {}) {
  // The lease the landing takes names the back-off that delayed it.
  if (backoff?.backoffMs) process.env.PULLBOARD_LANDING_BACKOFF_MS = String(backoff.backoffMs);
  else delete process.env.PULLBOARD_LANDING_BACKOFF_MS;
  let observed = landingObservation(root);
  if (!observed.waiting) return;
  const before = observed;
  let held = null, refused = false;
  try { await land(context(wakeIo(root))); }
  catch (error) {
    if (HELD_TRUNK_REFUSALS.has(error.code)) held = error.code;
    else if (retryableLandingRefusal(error.code)) refused = true;
    else throw error;
  }
  finally { delete process.env.PULLBOARD_LANDING_BACKOFF_MS; }
  observed = landingObservation(root);
  if (!observed.waiting) return;
  const moved = observed.main !== before.main || observed.branch !== before.branch
    || observed.verified.join() !== before.verified.join();
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
      // The lander's own look comes first: a trigger it sees wakes the next attempt even when a command already rescheduled it.
      if (landingWakeTrigger(next.marks, marks(root))) {
        return { reloadAt: new Date(now() + 1000).toISOString(), workerUrl: new URL('./automatic-landing.js', import.meta.url) };
      }
      observed = landingObservation(root);
      if (!observed.waiting || observed.pending !== started.pending) return;
    }
    return { reloadAt: next.retryAt, workerUrl: new URL('./automatic-landing.js', import.meta.url), backoff: next };
  }
  while (observed.main === before.main && observed.branch === before.branch) {
    if (observed.pending !== before.pending) return;
    await wait(pollMs);
    observed = landingObservation(root);
    if (!observed.waiting) return;
  }
  // Reload accepted tooling in a fresh worker; this process may have loaded the code the main correction replaced.
  return { reloadAt: new Date(now() + 1000).toISOString(), workerUrl: new URL('./automatic-landing.js', import.meta.url) };
}

if (process.argv[1] === FILE) {
const [root, token, scheduled, wakeFlag, dueAt] = process.argv.slice(2);
if (!isAbsolute(root ?? '') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')
  || scheduled !== '--scheduled' || wakeFlag !== '--wake-at' || !Number.isFinite(Date.parse(dueAt)) || process.argv.length !== 7) {
  throw new Error('automatic landing requires its registered root, token and wake time');
}
for (const key of [...AGENT_SESSION_IDS, ...AGENT_SHELL_MARKERS, 'PULLBOARD_AGENT', 'PULLBOARD_AGENT_ID', 'PULLBOARD_PARENT_SESSION']) delete process.env[key];
await resumeAutomaticLanding(root, token, dueAt, runLandingWake, { marks: landingWakeMarks });

}
