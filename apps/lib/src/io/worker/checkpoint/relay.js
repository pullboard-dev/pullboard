import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
/**
 * The background checkpoint publisher for one board (#1014): waits until moves have been quiet, uploads one
 * checkpoint under the relay lock, and goes again only if a move arrived meanwhile. One runs per board at a time;
 * a second exits at once. A failure leaves the sealed checkpoint saved in the link for the next publisher to retry.
 *
 * Usage (spawned by scheduleCheckpoint): node relay-checkpoint-worker.js <root> <relay link file>
 */
import {
  appendFileSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { locked } from '../../../../../../packages/link/index.js';
import {
  checkpointInBackground,
  scheduleCheckpoint,
  requestCheckpointCheck,
  checkpointFiles,
  checkpointQuietMs,
  publisherHolding,
} from '../../../../../../packages/outbox/index.js';
import { publishLatestCheckpoint } from '../../../../../../packages/link/index.js';
import {
  openBoard,
  nativeBoardPorts,
} from '../../../logic/native.js';
import { checkpointPublisher } from '../../../../../../packages/outbox/index.js';
import { relayOrdering } from '../../../../../../packages/outbox/index.js';
import {
  flushOutbox,
  queueMove,
  outboxHasPendingCreatedItem,
  outboxFields,
  ACKNOWLEDGED_OPERATIONS,
  outboxQueueable,
} from '../../../../../../packages/outbox/index.js';
const checkpointWorker = fileURLToPath(new URL('./relay.js', import.meta.url));
const outboxPolicy = () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable });
import { withOutboxGuard } from '../../../../../../packages/outbox/index.js';
import { replay as replayConflictRecord } from '../../../../../../packages/outbox/index.js';
import {
  remoteBoardMissing,
  uncertainUploadFailure,
  decideUncertainBaseline,
} from '../../../../../../packages/outbox/index.js';

// Importing the process root must not start a publisher in the caller's process.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, file] = process.argv.slice(2);
  const { due, done, asked, checked, pid, log } = checkpointFiles(file);

  /** Read a time one of the publisher's files holds, or 0 when none was noted. */
  function noted(path) {
    try { return Number(readFileSync(path, 'utf8')) || 0; } catch { return 0; }
  }

  /** Read the time of the last move, or 0 when none was noted. */
  function lastMove() { return noted(due); }

  /** Read the move time the last upload covered, or 0. */
  function lastCovered() { return noted(done); }

  /** Whether a command asked for a presentation check after the board was last read for a checkpoint. */
  function checkWanted() { return noted(asked) > noted(checked); }

  /**
   * Read and seal the board, noting when it was read: a check asked before then is answered by this read. A read
   * that fails or finds nothing to send answers it too; the next command asks again, so this publisher never spins.
   */
  async function publishFrom(options) {
    const reading = Date.now();
    try { return await publishLatestCheckpoint(root, io, options); }
    finally { writeFileSync(checked, `${reading}\n`, { mode: 0o600 }); }
  }

  /**
   * Claim the publisher's place for this board. The decision is made under the relay lock, so two publishers that
   * both find a dead holder's claim cannot each replace it: the second sees the first's live claim and stands down.
   */
  async function claim() {
    return locked(file, () => {
      const holder = publisherHolding(pid);
      if (holder && holder !== process.pid) return false;
      writeFileSync(pid, `${process.pid}\n`, { mode: 0o600 });
      writeFileSync(log, '', { mode: 0o600 }); // Each publisher keeps only its own short story.
      io.say(`claimed by ${process.pid}`);
      return true;
    }, io);
  }

  // Budget: refresh the claim well inside its ten-minute staleness, even during one long read or upload, so a live
  // publisher is never taken for a dead one and a second publisher never uploads beside it.
  const HEARTBEAT_MS = 60_000;
  setInterval(() => {
    try { if (Number(readFileSync(pid, 'utf8')) === process.pid) utimesSync(pid, new Date(), new Date()); } catch { /* No claim to refresh. */ }
  }, HEARTBEAT_MS).unref();

  /** Give up the claim under the relay lock, and only while it is still this process's own. */
  async function release() {
    await locked(file, () => {
      try { if (Number(readFileSync(pid, 'utf8')) === process.pid) rmSync(pid, { force: true }); } catch { /* Already gone. */ }
    }, io);
  }

  /** Keep a short record of failures beside the link; the next command's status reports pending uploads. */
  const io = {
    openBoard, nativeBoardPorts,
    withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem,
    // Progress goes to the same short log as failures, so a stalled publisher shows how far it got.
    say(line) { io.err(line); },
    err(line) { try { appendFileSync(log, `${new Date().toISOString()} ${String(line).trim()}\n`, { mode: 0o600 }); } catch { /* No log is no worse than none. */ } },
  };

  /**
   * Publish until a checkpoint covers the last move and answers the last check request; returns the time of the move
   * it covered. Moves go first; a check reads the board once commands go quiet and uploads only a changed page.
   */
  async function publishUntilQuiet() {
    const quiet = checkpointQuietMs();
    for (;;) {
      // Refresh the claim, so a scheduler never takes this live publisher for a dead one.
      try { utimesSync(pid, new Date(), new Date()); } catch { /* A removed claim is re-made by the next pass. */ }
      const moved = lastMove();
      const movePending = lastCovered() < moved;
      // An earlier publisher already covered this move and answered every check: nothing to send.
      if (!movePending && !checkWanted()) return moved;
      const since = movePending ? moved : noted(asked);
      const wait = quiet - (Date.now() - since);
      if (wait > 0) { await new Promise(next => setTimeout(next, wait)); continue; }
      if (movePending) {
        io.say(`publishing for the move at ${new Date(moved).toISOString()}`);
        if (await publishFrom()) writeFileSync(done, `${moved}\n`, { mode: 0o600 });
        io.say('published');
        if (lastMove() === moved && !checkWanted()) return moved;
      } else {
        io.say('checking the presentation');
        await publishFrom({ ifChanged: true });
      }
    }
  }

  // A move noted after the last look, but before the claim was released, saw a live publisher and spawned none:
  // look once more after releasing, and go again if it is newer than what was covered.
  for (let covered = -1; await claim();) {
    try { covered = await publishUntilQuiet(); }
    catch (error) { io.err(`checkpoint not published: ${error.message}`); covered = Infinity; }
    finally { await release(); }
    if (lastMove() <= covered && !checkWanted()) break;
  }
}
