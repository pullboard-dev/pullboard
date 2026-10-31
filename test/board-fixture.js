import { fileURLToPath } from 'node:url';
/** SQLite fixture boards default to memory; disk is an explicit boundary contract [C7]. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBoard, nativeBoardPorts } from '../src/native-board.js';
import { openBoardForRead } from '../src/native-board.js';
import { closeBoard } from '../src/native-board.js';
import { Refused } from '../src/refused.js';
import { flushOutbox, queueMove, outboxHasPendingCreatedItem, outboxFields, ACKNOWLEDGED_OPERATIONS, outboxQueueable } from '../src/relay-outbox.js';
const checkpointWorker = fileURLToPath(new URL('../src/relay-checkpoint-worker.js', import.meta.url));
const outboxPolicy = () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable });
import { withOutboxGuard } from '../src/relay-outbox-guard.js';
import { replay as replayConflictRecord } from '../src/relay-conflict-record.js';
import { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } from '../src/relay-baseline-settle.js';
import { checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck } from '../src/relay-checkpoint.js';
import { checkpointPublisher } from '../src/relay-checkpoint-publish.js';
import { relayOrdering } from '../src/relay-ordering.js';

const FILE_PURPOSES = new Set(['persistence', 'locking', 'migration']);

/**
 * Open the production schema and moves in memory, with cleanup owned by the test.
 * A file requires a named database boundary; an unsupported mode never silently falls back.
 */
export function fixtureBoard(t, { clock, storage = 'memory', purpose } = {}) {
  if (storage !== 'memory' && storage !== 'file') {
    throw new Refused('TEST_BOARD_STORAGE', 'choose memory, or file with a persistence, locking or migration purpose');
  }
  if ((storage === 'file' && !FILE_PURPOSES.has(purpose)) || (storage === 'memory' && purpose !== undefined)) {
    throw new Refused('TEST_BOARD_STORAGE', 'use memory for logic; file boards require a persistence, locking or migration purpose');
  }
  let file = ':memory:';
  let directory;
  if (storage === 'file') {
    directory = mkdtempSync(join(tmpdir(), 'pullboard-board-contract-'));
    file = join(directory, 'board.sqlite');
  }
  try {
    const board = openBoard(file, clock);
    t.after(() => {
      try { closeBoard(board); }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
    });
    return board;
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Bind the actual native openers at API fixture roots, never inside API projection code. */
export const apiBoardOpeners = Object.freeze({ openBoard, openBoardForRead, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem });
