import { fileURLToPath } from 'node:url';
/** SQLite fixture boards default to memory; disk is an explicit boundary contract [C7]. */
// The board composition root by its module, not the library front door: that door also exports the CLI's main (#3852).
import { openBoard } from '../../../lib/index.js';
import { nativeBoardPorts } from '../../../lib/index.js';
import { openBoardForRead } from '../../../lib/index.js';
import { recordFlakeObservation } from '../../../lib/index.js';
import { draftSpecRow } from '../../../lib/index.js';
import { moveArgs } from '../../../../packages/person/index.js';
import { receiveCommits } from '../../../../packages/pin/index.js';
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

/** The fixture board lives in packages/board/tests/fixtures; the app keeps it reachable by its old path, through the lib app's door [C7]. */
export { fixtureBoard, fixtureOpenBoard, openKitBoard, withFixtureBoard } from '../../../lib/tests/fixtures/board.js';
export { temporaryDirectory } from '../../../../packages/store/tests/fixtures/tmp.js';

/** Bind the actual native openers at API fixture roots, never inside API projection code. */
export const apiBoardOpeners = Object.freeze({ recordFlakeObservation, draftSpecRow, moveArgs, receiveCommits, openBoard, openBoardForRead, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem });
