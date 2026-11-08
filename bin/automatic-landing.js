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
import { retryableLandingRefusal } from '../packages/landing/src/core/automatic-landing-retry.js';
import { mainCheckout, invalidateGitFacts } from '../packages/git/index.js';
import { listItems } from '../packages/store/index.js';
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
  return { main: trunk?.commit, branch: trunk?.branch,
    waiting: withBoardRead(ctx, board => listItems(board, { all: true })
      .some(item => item.item_status === 'verified' && !item.item_merged_commit)),
    pending: readMainAudit(join(automaticLandingDirectory(root), 'pending.json'))?.id };
}

/**
 * Bootstrap observation for verified work left by an older worker, without replacing a concurrent accept [B35].
 * schemaDiagnostics is the calling command's set of already-reported board mismatches.
 */
export async function bootstrapLandingWake(root, { schedule = scheduleAutomaticLanding, now = Date.now, schemaDiagnostics } = {}) {
  const primary = primaryCheckoutRoot(context(wakeIo(root, { schemaDiagnostics })).info);
  if (!primary || readMainAudit(join(automaticLandingDirectory(primary), 'pending.json'))) return false;
  const observed = landingObservation(primary, { schemaDiagnostics });
  if (!observed.waiting || !observed.branch || !automaticLandingEnabled(mainPolicy(primary).config)) return false;
  return Boolean(await schedule(primary, new Date(now() + 1000).toISOString(), new URL('./automatic-landing.js', import.meta.url),
    { expectedId: null }));
}

/**
 * Keep authenticated custody while accepted work waits for a main correction, without holding a landing or gate lease.
 * New accepts return to the scheduler's existing due-time/coalescing loop; an unchanged main never hot-retries a refusal.
 */
export async function runLandingWake(root, { land = landAfterAcceptance, wait = pause, pollMs = 5000, now = Date.now } = {}) {
  let observed = landingObservation(root);
  if (!observed.waiting) return;
  const before = observed;
  try { await land(context(wakeIo(root))); }
  catch (error) { if (!retryableLandingRefusal(error.code)) throw error; }
  observed = landingObservation(root);
  if (!observed.waiting) return;
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
await resumeAutomaticLanding(root, token, dueAt, runLandingWake);

}
