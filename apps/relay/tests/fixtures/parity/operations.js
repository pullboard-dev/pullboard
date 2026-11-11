import { seedStaleState } from '../../../../../packages/health/tests/fixtures/stale.js';
/** Exercise every declared native operation through the complete current reader oracle [H5,H16,A2]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as rawStore from '../../../../../packages/store/index.js';
import {
  openBoard,
  nativeBoardPorts,
} from '../../../../lib/index.js';
import { draftSpecRow } from '../../../../lib/index.js';
import { recordRowVerification } from '../../../../lib/index.js';
import { decideSpecRevisions } from '../../../../lib/index.js';
import {
  addMilestone,
  editMilestone,
  editMilestoneItems,
  orderMilestoneItems,
  moveMilestone,
  removeMilestone,
  shipMilestone,
  roadmap,
} from '../../../../../packages/store/index.js';
import { MOVE_OPERATIONS } from '../../../../../packages/moves/index.js';
import { publishLatestCheckpoint } from '../../../../../packages/link/index.js';
import { checkpointPublisher } from '../../../../../packages/outbox/index.js';
import { captureSpecApprovalBaseline } from '../../../../../packages/spec/index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { decodeBoardKey } from '../../../../../packages/kernel/index.js';
import {
  createParityReader,
  assertReaderParity,
} from '../../../../cli/tests/fixtures/relay/parity/reader.js';
import {
  createStudyExercise,
  seedStudyState,
  seedRehome,
  seedHandoff,
} from '../../../../../packages/store/tests/fixtures/relay/parity/seeds.js';
import { submitFixture } from '../../../../cli/tests/fixtures/board/submit.js';
import {
  seedOutside,
  seedLandingObservations,
  seedMembership,
  seedAdministrative,
  seedBatch,
  seedCoordinatorAuthority,
  seedSpecOutcomes,
  seedBarSignature,
  seedCurrentOperations,
  seedPersonSigning,
  seedUsage,
} from '../../../../../packages/gate/tests/fixtures/seeds.js';
import { seedTypedRequests } from './requests.js';
import { seedSourceAdvance } from '../../../../../packages/landing/tests/fixtures/relay/parity/advance.js';
import { seedNativeTrain } from '../../../../../packages/landing/tests/fixtures/relay/parity/train.js';
import { seedItemPatches } from '../../../../../packages/items/tests/fixtures/patches.js';
import { seedSubmitHandoff } from '../../../../../packages/sandbox/tests/fixtures/handoff.js';
import {
  seedSelectorGap,
  seedAcceptedReland,
} from '../../../../../packages/store/tests/fixtures/relay/parity/reland.js';
import { syntheticFlakeObservation } from '../../../../cli/tests/fixtures/observation.js';

/** The fixture root supplies canonical native operations to the unchanged lower recipes. */
const store = Object.freeze({ ...rawStore, ensureCoordinator: rawStore.board_ensureCoordinator, recordNextIdle: rawStore.board_recordNextIdle,
  openBoard, draftSpecRow, recordRowVerification, decideSpecRevisions });
/** The milestone writers the recipes exercise, as the old milestones module named them. */
const milestones = Object.freeze({ addMilestone, editMilestone, editMilestoneItems, orderMilestoneItems, moveMilestone, removeMilestone, shipMilestone, roadmap });

/** Run inside the existing private fixture's genuine environment, retaining one HTTP server and person session. */
export async function exerciseOperationParity({ root, origin, token, boardId, lane, keyFile }) {
  const key = decodeBoardKey(readFileSync(keyFile, 'utf8').trim());
  const reader = await createParityReader({ root, origin, token, boardId, key });
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: root });
  const notices = [];
  const io = { checkpointPublisher, nativeBoardPorts, say() {}, err(message) { notices.push(message); } };
  let observing = 'initial baseline';
  /** Publish with the actual production capture/seal/HTTP path, then compare both full readers before covering the move. */
  async function verifyAfterMutation({ operation, after }) {
    observing = operation;
    assert.equal(await publishLatestCheckpoint(root, io), true, `the ${operation} checkpoint is acknowledged`);
    const { native, relay } = await reader.read();
    assert.ok(native.sequence >= after, `the ${operation} observation includes its actual native event`);
    assertReaderParity(native, relay);
  }
  const tracking = createStudyExercise({ board, verifyAfterMutation });
  const context = { board, box: { root, lane }, store, milestones, ...tracking, submitFixture, syntheticFlakeObservation };
  try {
    const baseline = store.specApprovalBaseline(board);
    if (baseline) {
      // init records this immutable baseline before pairing is possible. Its actual event and the
      // first complete reader observation cover that bootstrap input; a no-op repeat never does.
      const event = store.events(board).find(event => event.event_kind === 'spec_approval_baseline');
      assert.ok(event, 'the initial baseline has a real native mutation receipt');
      await verifyAfterMutation({ operation: 'recordSpecApprovalBaseline', after: event.event_id });
      tracking.covered.add('recordSpecApprovalBaseline');
    } else {
      await tracking.exercise('recordSpecApprovalBaseline', () => store.recordSpecApprovalBaseline(board, {
        agentId: 'coordinator', baseline: captureSpecApprovalBaseline(root, loadConfig(root)) }));
    }
    await seedStudyState(context);
    await seedItemPatches(context);
    process.stderr.write('parity phase seedSourceAdvance begin\n');
    await seedSourceAdvance(context);
    process.stderr.write('parity phase seedSourceAdvance complete\n');
    await seedSubmitHandoff(context);
    await seedOutside(context);
    await seedLandingObservations(context);
    await seedMembership(context);
    await seedAdministrative(context);
    await seedTypedRequests(context);
    await seedStaleState(context);
    await seedBatch(context);
    process.stderr.write('parity phase seedNativeTrain begin\n');
    await seedNativeTrain(context);
    process.stderr.write('parity phase seedNativeTrain complete\n');
    await seedSpecOutcomes(context);
    await seedCurrentOperations(context);
    await seedSelectorGap(context);
    await seedAcceptedReland(context);
    await seedBarSignature(context);
    await seedCoordinatorAuthority(context);
    await seedRehome(context);
    await seedUsage(context);
    await seedHandoff(context);
    await seedPersonSigning(context);
    const missing = tracking.missing(MOVE_OPERATIONS);
    assert.deepEqual(missing, [], `every declared native operation must pass the complete oracle; setup refusals=${JSON.stringify(tracking.setupRefusals)}`);
    return { covered: [...tracking.covered].sort(), declared: [...MOVE_OPERATIONS].sort() };
  } catch (error) {
    error.message = `while observing ${observing}: ${error.message}; covered=${JSON.stringify([...tracking.covered])}; setupRefusals=${JSON.stringify(tracking.setupRefusals)}`;
    throw error;
  } finally {
    store.closeBoard(board);
    await reader.close();
  }
}
