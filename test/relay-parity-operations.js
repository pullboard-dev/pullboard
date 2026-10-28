import { seedStaleState } from './relay-parity-stale-state.js';
/** Exercise every declared native operation through the complete current reader oracle [H5,H16,A2]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../src/board.js';
import * as milestones from '../src/board.js';
import { MOVE_OPERATIONS } from '../src/move-registry.js';
import { publishLatestCheckpoint } from '../src/relay.js';
import { captureSpecApprovalBaseline } from '../src/spec-approval.js';
import { loadConfig } from '../src/config.js';
import { decodeBoardKey } from '../src/seal.js';
import { createParityReader, assertReaderParity } from './relay-parity-reader.js';
import { createStudyExercise, seedStudyState, seedRehome, seedHandoff } from './relay-parity-seeds.js';
import { submitFixture } from './board-submit-fixture.js';
import { seedOutside, seedLandingObservations, seedMembership, seedAdministrative, seedBatch, seedCoordinatorAuthority, seedSpecOutcomes, seedBarSignature, seedCurrentOperations, seedPersonSigning, seedUsage } from './relay-parity-extra-seeds.js';
import { seedTypedRequests } from './relay-parity-typed-requests.js';
import { seedSourceAdvance } from './relay-parity-source-advance.js';
import { seedItemPatches } from './relay-parity-item-patches.js';
import { syntheticFlakeObservation } from './flake-observation-fixture.js';

/** Run inside the existing private fixture's genuine environment, retaining one HTTP server and person session. */
export async function exerciseOperationParity({ root, origin, token, boardId, lane, keyFile }) {
  const key = decodeBoardKey(readFileSync(keyFile, 'utf8').trim());
  const reader = await createParityReader({ root, origin, token, boardId, key });
  const board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  const notices = [];
  const io = { say() {}, err(message) { notices.push(message); } };
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
    await seedSourceAdvance(context);
    await seedOutside(context);
    await seedLandingObservations(context);
    await seedMembership(context);
    await seedAdministrative(context);
    await seedTypedRequests(context);
    await seedStaleState(context);
    await seedBatch(context);
    await seedSpecOutcomes(context);
    await seedCurrentOperations(context);
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
