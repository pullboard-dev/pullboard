import { seedStaleState } from '../../../../../packages/health/tests/fixtures/stale.js';
/** Exercise every declared native operation through the complete current reader oracle [H5,H16,A2]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  seedIdentity,
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
import { FIXTURE_MODEL } from '../../../../cli/tests/fixtures/testkit.js';
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

/** The CLI file the train fixture's `pullboard` shim runs. */
const CLI_ENTRY = fileURLToPath(new URL('../../../../cli/pullboard.js', import.meta.url));

/** The fixture root supplies canonical native operations to the unchanged lower recipes. */
const store = Object.freeze({ ...rawStore, ensureCoordinator: rawStore.board_ensureCoordinator, recordNextIdle: rawStore.board_recordNextIdle,
  openBoard, draftSpecRow, recordRowVerification, decideSpecRevisions });
/** The milestone writers the recipes exercise, as the old milestones module named them. */
const milestones = Object.freeze({ addMilestone, editMilestone, editMilestoneItems, orderMilestoneItems, moveMilestone, removeMilestone, shipMilestone, roadmap });

/** Run inside the existing private fixture's genuine environment, retaining one HTTP server and person session. */
export async function exerciseOperationParity({ root, origin, token, boardId, lane, keyFile, part }) {
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
    /** Rebuild the seat, reviewer, item and claim the later recipes read, as the study lifecycle leaves them. */
    async function seedSeats() {
      await seedIdentity(context);
      context.claim = { agentId: context.agent, lane, leaseMs: 3600000,
        freeze: () => ({ text: '{"rows":[],"criterion":"A seeded lifecycle."}', digest: 'study-frozen' }) };
    }
    /** The phases of each part: together they are the original single sequence, on separate boards. */
    const phases = {
      study: [() => seedStudyState(context)],
      rest: [seedSeats,
        () => seedItemPatches(context),
        async () => {
          process.stderr.write('parity phase seedSourceAdvance begin\n');
          await seedSourceAdvance(context);
          process.stderr.write('parity phase seedSourceAdvance complete\n');
        },
        () => seedSubmitHandoff(context),
        () => seedOutside(context),
        () => seedLandingObservations(context),
        () => seedMembership(context),
        () => seedAdministrative(context),
        () => seedTypedRequests(context),
        () => seedStaleState(context),
        () => seedBatch(context),
        async () => {
          process.stderr.write('parity phase seedNativeTrain begin\n');
          await seedNativeTrain(context, { cli: CLI_ENTRY });
          process.stderr.write('parity phase seedNativeTrain complete\n');
        },
        () => seedSpecOutcomes(context),
        () => seedCurrentOperations(context),
        () => seedSelectorGap(context),
        () => seedAcceptedReland(context),
        () => seedBarSignature(context),
        () => seedCoordinatorAuthority(context),
        () => seedRehome(context),
        () => context.store.claim(board, context.item, context.claim), // the usage recipes record against an item this seat claimed
        () => seedUsage(context),
        // The coordinator usage move names no item; its receipt is the native event the oracle compares.
        () => tracking.exercise('recordCoordinatorUsage', () => store.recordCoordinatorUsage(board, { agentId: 'coordinator', session: 'parity-coordinator-session',
          observedAt: board.clock.now().getTime(), records: [{ model: FIXTURE_MODEL, inputTokens: null, outputTokens: null, wallMs: 0,
            knownInputTokens: 0, knownOutputTokens: 0, unknownReasons: ['native-session-unavailable'] }] })),
        () => seedHandoff(context),
        () => seedPersonSigning(context)],
    };
    if (!phases[part]) throw new TypeError(`unknown operation part ${part}`);
    const timings = [];
    for (const phase of phases[part]) { const t0 = Date.now(); await phase(); timings.push(Date.now() - t0); }
    return { timings, covered: [...tracking.covered].sort(), declared: [...MOVE_OPERATIONS].sort(), setupRefusals: tracking.setupRefusals };
  } catch (error) {
    error.message = `while observing ${observing}: ${error.message}; covered=${JSON.stringify([...tracking.covered])}; setupRefusals=${JSON.stringify(tracking.setupRefusals)}`;
    throw error;
  } finally {
    store.closeBoard(board);
    await reader.close();
  }
}
