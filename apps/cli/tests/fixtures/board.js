import { fileURLToPath } from 'node:url';
/** SQLite fixture boards default to memory; disk is an explicit boundary contract [C7]. */
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The board composition root by its module, not the library front door: that door also exports the CLI's main (#3852).
import { openBoard } from '../../../lib/index.js';
import { nativeBoardPorts } from '../../../lib/index.js';
import { openBoardForRead } from '../../../lib/index.js';
import { closeBoard } from '../../../lib/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { moveArgs } from '../../../../packages/person/index.js';
import {
  flushOutbox,
  queueMove,
  outboxHasPendingCreatedItem,
  outboxFields,
  ACKNOWLEDGED_OPERATIONS,
  outboxQueueable,
} from '../../../../packages/outbox/index.js';
const checkpointWorker = fileURLToPath(new URL('../../../lib/src/io/worker/checkpoint/relay.js', import.meta.url));
const outboxPolicy = () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable });
import { withOutboxGuard } from '../../../../packages/outbox/index.js';
import { replay as replayConflictRecord } from '../../../../packages/outbox/index.js';
import {
  remoteBoardMissing,
  uncertainUploadFailure,
  decideUncertainBaseline,
} from '../../../../packages/outbox/index.js';
import {
  checkpointInBackground,
  scheduleCheckpoint,
  requestCheckpointCheck,
} from '../../../../packages/outbox/index.js';
import { checkpointPublisher } from '../../../../packages/outbox/index.js';
import { relayOrdering } from '../../../../packages/outbox/index.js';

const FILE_PURPOSES = new Set(['persistence', 'locking', 'migration']);

/** Make an empty temporary directory; the caller removes it. The single place fixtures create one [C7]. */
export function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

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
    directory = temporaryDirectory('pullboard-board-contract-');
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
export const apiBoardOpeners = Object.freeze({ moveArgs, openBoard, openBoardForRead, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem });
