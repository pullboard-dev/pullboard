import { viewApiPorts } from '../../../../view/index.js';
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../../lib/index.js';
/** Native cached HTTP state keeps the same explicit clock as a fresh relay reader [H5,H16,A2]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { addMilestone } from '../../../../../packages/store/index.js';
import { serveApi } from '../../../../../packages/api/index.js';
import { refusalDocument } from '../../../index.js';
import { main } from '../../../tests/fixtures/native.js';
import { recordBlock } from '../../../../../packages/items/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import {
  resolveCommit,
  tryGit,
} from '../../../../../packages/git/index.js';
import { relayPresentation } from '../../../../../packages/pages/index.js';
import { snapshotState } from '../../../../relay/index.js';
import { assertReaderParity } from '../../../tests/fixtures/relay/parity/reader.js';
import { LOCAL_PARITY_FIELDS } from '../../../tests/fixtures/relay/parity/reader.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

const HOUR = 3_600_000;
/** The API state read keeps spec and doctrine row ages for a later refresh (5bf1070838), so its first read has none where a relay reader walks history [C7]. */
const CLOCK_PARITY = [...LOCAL_PARITY_FIELDS, { path: 'rowAgesAt', reason: 'The API state read answers at once and refreshes row ages later; the relay reader computes them in line.' }];

/** Expose a real initialized SQLite board through HTTP with only the existing internal constructor clock port. */
async function clockFixture(t) {
  const box = await relayClientFixture(t);
  const base = Date.now() + 1_000;
  const clock = { value: base };
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(base) });
  t.after(() => store.closeBoard(board));
  const id = store.boardId(board);
  let builds = 0;
  const secret = randomBytes(24).toString('base64url');
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret, runCommand: main, projects: () => [{ root: box.root, name: 'clock-parity' }],
    scope: { projectRoot: box.root }, isMain: true, stateDetail: 'full', now: () => clock.value, onStateBuild: () => { builds++; } });
  t.after(api.close);
  /** Compare the complete authenticated native response with the uncached production reader at exactly its clock.
   * This additional cache witness makes no API2/decryption claim; that transport has its separate real oracle.
   */
  async function read() {
    const response = await fetch(`http://127.0.0.1:${api.port}/api/v1/boards/${id}/state?detail=full`, { headers: { 'x-pullboard-key': secret } });
    assert.equal(response.status, 200);
    const native = (await response.json()).state;
    const presentation = relayPresentation(box.root, { observedAt: clock.value }, RELAY_PRESENTATION_PORTS);
    const relay = snapshotState({ ...exportBoard(board), presentation }, id);
    assert.equal(native.observedAt, new Date(clock.value).toISOString());
    assert.equal(relay.observedAt, native.observedAt);
    return { native, relay };
  }
  return { ...box, board, base, clock, read, builds: () => builds };
}

test('native and relay readers expire a person block at the same observedAt without a write [H5,H16,A2]', { timeout: 60_000 }, async t => { // budget: real fixture startup, HTTP and cleanup; clock advancement never sleeps.
  const box = await clockFixture(t);
  recordBlock(join(box.root, '.git'), { at: new Date(box.base).toISOString(), code: 'PARITY_CLOCK_FIXTURE', command: 'synthetic projection input',
    by: 'coordinator', path: box.root, audience: 'person', reason: 'A private fixture block expires after a day.', step: 'Inspect the unchanged board.' });
  box.clock.value = box.base + 24 * HOUR - 1;
  const before = await box.read();
  assert.equal(before.native.blocks.length, 1, 'the real recorded person block is still within its window');
  assertReaderParity(before.native, before.relay, CLOCK_PARITY);
  const inputs = exportBoard(box.board);
  box.clock.value += 2;
  const after = await box.read();
  assert.deepEqual(exportBoard(box.board), inputs, 'clock advancement makes no native mutation');
  assert.equal(after.relay.blocks.length, 0, 'the fresh production reader expires the recorded block');
  assertReaderParity(after.native, after.relay, CLOCK_PARITY);
});

/** Seed real lifecycle events with synthetic acceptance metadata; this is not gate, CI or outside-review assurance. */
function seedLandingPace(box) {
  const builder = store.register(box.board, { lane: box.lane, path: join(box.root, 'clock-builder'), family: 'Fixture Clock Builder Vendor', parentDigest: 'a'.repeat(64) });
  const reviewer = store.register(box.board, { lane: 'tests', path: join(box.root, 'clock-reviewer'), family: 'Fixture Clock Reviewer Vendor', parentDigest: 'b'.repeat(64) });
  const head = resolveCommit(box.root, 'HEAD');
  const tree = tryGit(box.root, ['rev-parse', `${head}^{tree}`]).stdout.trim();
  for (let index = 0; index < 3; index++) {
    const id = store.addItem(box.board, { by: 'coordinator', lane: box.lane, title: `Synthetic pace item ${index}`, criterion: 'Recorded landing pace remains visible' });
    const frozen = { text: '{"rows":[]}', digest: `synthetic-pace-${index}` };
    store.claim(box.board, id, { agentId: builder, lane: box.lane, leaseMs: HOUR, head, freeze: () => frozen });
    submitFixture(box.board, id, { agentId: builder, commit: head, tree });
    store.reserveReview(box.board, id, { agentId: reviewer, lane: 'tests', leaseMs: HOUR, policy: 'any' });
    store.verify(box.board, id, { agentId: reviewer, decision: 'ACCEPT', head, digest: frozen.digest, policy: 'any', familyPolicy: 'off',
      note: 'Synthetic projection state only; no gate or assurance.', review: { commit: head, head, trunk: head, paths: [] } });
    store.merged(box.board, id, { agentId: 'coordinator', commit: head });
  }
  const pending = store.addItem(box.board, { by: 'coordinator', lane: box.lane, title: 'Pace forecast input', criterion: 'A pending item observes the current landing window' });
  addMilestone(box.board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Clock pace', items: [pending] });
}

test('native and relay readers cross a landing pace window at the same observedAt without a write [H5,H16,A2]', { timeout: 60_000 }, async t => { // budget: real fixture startup, native lifecycle inputs, HTTP and cleanup; no timed wait.
  const box = await clockFixture(t);
  seedLandingPace(box);
  box.clock.value = box.base + 2 * HOUR - 1;
  const before = await box.read();
  assert.equal(before.native.milestones.find(row => row.name === 'Clock pace').summary.pace.last2h, 3);
  assertReaderParity(before.native, before.relay, CLOCK_PARITY);
  const inputs = exportBoard(box.board);
  box.clock.value += 2;
  const after = await box.read();
  assert.deepEqual(exportBoard(box.board), inputs, 'clock advancement makes no native mutation');
  assert.equal(after.relay.milestones.find(row => row.name === 'Clock pace').summary.pace.last2h, 0);
  assertReaderParity(after.native, after.relay, CLOCK_PARITY);
});


test('clock windows retain cached reads and refresh exact boundaries and backwards time [H5,H16,A2]', { timeout: 60_000 }, async t => { // budget: real fixture startup and bounded HTTP reads; all clock shifts are immediate.
  const box = await clockFixture(t);
  seedLandingPace(box);
  recordBlock(join(box.root, '.git'), { at: new Date(box.base).toISOString(), code: 'PARITY_BOUNDARY_FIXTURE', command: 'synthetic boundary input',
    by: 'coordinator', path: box.root, audience: 'person', reason: 'Exact inclusive block boundary.', step: 'Inspect the unchanged board.' });
  const inputs = exportBoard(box.board);
  /** Every additional boundary still compares the entire public state at one explicit clock. */
  async function observe(offset, expectedBuilds) {
    box.clock.value = box.base + offset;
    const states = await box.read();
    assertReaderParity(states.native, states.relay, CLOCK_PARITY);
    assert.equal(box.builds(), expectedBuilds, 'cache survives stable intervals and refreshes progress or pace boundaries [B35]');
    return states.native;
  }
  await observe(2 * HOUR - 2, 1);
  await observe(2 * HOUR - 1, 1);
  const twoHours = await observe(2 * HOUR, 2);
  assert.equal(twoHours.milestones.find(row => row.name === 'Clock pace').summary.pace.last2h, 0, 'pace excludes its exact lower boundary');
  const threeHours = await observe(3 * HOUR, 3);
  /** Idle minutes as a reader derives them: items carry no idle clock (461f2e43b1), only last activity and the read's observedAt. */
  const idle = state => Math.floor((Date.parse(state.observedAt) - Date.parse(state.items[0].progress.lastActivity)) / 60_000);
  assert.equal(idle(threeHours) - idle(twoHours), 60, 'idle time refreshes without a native move [B35]');
  await observe(2.5 * HOUR, 4); // A backwards clock rebuilds even without crossing a pace boundary.
  const sixHours = await observe(6 * HOUR, 5);
  assert.equal(sixHours.milestones.find(row => row.name === 'Clock pace').summary.pace.last6h, 0);
  const backwards = await observe(2 * HOUR - 1, 6);
  assert.equal(backwards.milestones.find(row => row.name === 'Clock pace').summary.pace.last2h, 3, 'a backwards clock restores the proper earlier window');
  const day = await observe(24 * HOUR, 7);
  assert.equal(day.blocks.length, 1, 'the block remains visible at its exact inclusive boundary');
  assert.equal(day.milestones.find(row => row.name === 'Clock pace').summary.pace.last24h, 0);
  const expired = await observe(24 * HOUR + 1, 8);
  assert.equal(expired.blocks.length, 0, 'the block expires on the next millisecond');
  assert.deepEqual(exportBoard(box.board), inputs, 'all clock-only reads preserve native business inputs');
});
