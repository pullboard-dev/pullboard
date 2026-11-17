import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../../lib/index.js';
/** Real loopback relay and complete native API observations for reader parity [H5,H15,H16,A2]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { addMilestone } from '../../../../../packages/store/index.js';
import { decodeBoardKey } from '../../../../../packages/kernel/index.js';
import { relayPresentation } from '../../../../../packages/pages/index.js';
import { presentationDigest } from '../../../../../packages/pages/index.js';
import { observeRelayHealth } from '../../../../../packages/link/index.js';
import { runFixtureChild } from '../child.js';
import { runFixtureChildAsync } from '../child.js';
export { assertReaderParity } from './parity/reader.js';
import { createParityReader } from './parity/reader.js';
import { relayClientFixture } from './client.js';

/** The parts of the operation inventory; operations.js names the phases each one runs. */
const OPERATION_PARTS = Object.freeze(['studyA', 'studyB', 'restA', 'restB']);

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

/** Seed actual native writes, keeping the operation receipts available for the fail-closed coverage inventory. */
export function seedParityBoard(root, lane) {
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  const exercised = new Set(['register', 'ensureCoordinator']); // The real fixture init executes these operations.
  /** Record only an operation whose actual native call returned successfully. */
  function moved(operation, action) { const result = action(); exercised.add(operation); return result; }
  try {
    const item = moved('addItem', () => store.addItem(board, { by: 'coordinator', lane, title: 'Reader parity lifecycle', criterion: 'Same native and relay fields' }));
    moved('editItem', () => store.editItem(board, item, { agentId: 'coordinator', brief: 'Reader parity updated' }));
    moved('shout', () => store.shout(board, { from: 'coordinator', to: 'person', text: 'Reader parity question', decision: true }));
    moved('addMilestone', () => addMilestone(board, { agentId: 'coordinator', name: 'Reader parity release' }));
    return { exercised: [...exercised], item };
  } finally { store.closeBoard(board); }
}

/** Clock advancement alone is not a board change, while a real native mutation always is. */
function assertPresentationChangeClock(root, item) {
  const first = relayPresentation(root, { observedAt: Date.UTC(2026, 0, 1) }, RELAY_PRESENTATION_PORTS);
  const later = relayPresentation(root, { observedAt: Date.UTC(2026, 0, 2) }, RELAY_PRESENTATION_PORTS);
  assert.notEqual(first.state.observedAt, later.state.observedAt, 'emitted observations retain their actual caller clock');
  assert.equal(presentationDigest(first), presentationDigest(later), 'an unchanged board does not publish merely because its clock advanced');
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  try { store.editItem(board, item, { agentId: 'coordinator', brief: 'Business input changed after the clock-only observation.' }); }
  finally { store.closeBoard(board); }
  const changed = relayPresentation(root, { observedAt: Date.UTC(2026, 0, 2) }, RELAY_PRESENTATION_PORTS);
  assert.notEqual(presentationDigest(later), presentationDigest(changed), 'a real business mutation changes the fingerprint at the same observation clock');
}

/** Give a scoped board a genuine foreign milestone target whose private title must stay outside its key. */
function foreignBoardFixture(t, box) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-parity-foreign-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: root, env: box.env, encoding: 'utf8' }).status, 0);
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  const secret = 'Foreign board private title must never enter another board snapshot';
  let id;
  try {
    store.board_ensureCoordinator(board, root);
    id = store.addItem(board, { by: 'coordinator', lane: box.lane, title: secret, criterion: 'Private second-board work' });
  } finally { store.closeBoard(board); }
  const own = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try { addMilestone(own, { agentId: 'coordinator', name: 'Cross-board privacy', items: [`foreign-parity#${id}`] }); }
  finally { store.closeBoard(own); }
  return { root, name: 'foreign-parity', secret };
}

/** Capture full API state and independently reconstruct the sealed API2 snapshot over actual authenticated HTTP. */
/** A linked relay fixture whose repo policy commit is in place, ready for one real device session [H5,H16,A2]. */
async function linkedParityBox(t) {
  const box = await relayClientFixture(t);
  assert.equal(runFixtureChild('git', ['add', 'pullboard.json'], { cwd: box.root, env: box.env }).status, 0);
  const git = args => runFixtureChild('git', args, { cwd: box.root, env: box.env, encoding: 'utf8' });
  const tree = git(['write-tree']);
  const parent = git(['rev-parse', 'HEAD']);
  assert.equal(tree.status, 0);
  assert.equal(parent.status, 0);
  const commit = git(['commit-tree', tree.stdout.trim(), '-p', parent.stdout.trim(), '-m', 'fixture: commit parity policy']);
  assert.equal(commit.status, 0);
  assert.equal(git(['update-ref', 'refs/heads/main', commit.stdout.trim(), parent.stdout.trim()]).status, 0);
  return box;
}

/** Link one fixture to its relay and open its person session, the same start every operation child needs. */
async function linkedSession(box) {
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const session = await box.phoneSession();
  return { link, session };
}

/** Run the operation inventory part `part` in its own child process against one linked fixture's board. */
async function runOperationPart(t, box, link, session, part) {
  const module = new URL('../../../../relay/tests/fixtures/parity/operations.js', import.meta.url).href;
  const parameters = { root: box.root, origin: box.origin, token: session.token, boardId: link.board, lane: box.lane, keyFile: box.keyFile, part };
  const file = join(box.root, '.git', 'pullboard', 'parity-reader-session.json');
  writeFileSync(file, JSON.stringify(parameters), { mode: 0o600 });
  try {
    const running = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `import { readFileSync } from 'node:fs';
import { exerciseOperationParity } from ${JSON.stringify(module)};
try { console.log(JSON.stringify(await exerciseOperationParity(JSON.parse(readFileSync(${JSON.stringify(file)}, 'utf8'))))); } catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }`], { cwd: box.root, env: box.env, signal: t.signal });
    t.after(async () => {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGTERM');
      await running;
    });
    const result = await running;
    let document;
    try { document = JSON.parse(result.stdout.trim()); }
    catch { assert.fail(`operation child did not return JSON: ${result.failure ?? result.context}`); }
    assert.equal(result.status, 0, `${document.error ?? 'operation child failed'}\n${result.failure ?? result.context}`);
    return document;
  } finally { rmSync(file, { force: true }); }
}

/** Capture full API state and independently reconstruct the sealed API2 snapshot over actual authenticated HTTP. */
export async function parityRoundtrip(t, { foreign = false, localHealth = false } = {}) {
  const box = await linkedParityBox(t);
  const seeded = seedParityBoard(box.root, box.lane);
  const other = foreign ? foreignBoardFixture(t, box) : null;
  assertPresentationChangeClock(box.root, seeded.item);
  if (localHealth) {
    const now = Date.now();
    for (const at of [now - 1, now]) observeRelayHealth(box.root, {
      ok: false, step: 'pull', code: 'RELAY_UNREACHABLE', roundTripMs: 1, relayVersion: 1,
    }, { now: at });
  }
  const { link, session } = await linkedSession(box);
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const reader = await createParityReader({ root: box.root, origin: box.origin, token: session.token, boardId: link.board, key,
    projects: () => [{ root: box.root, name: 'parity' }, ...(other ? [other] : [])] });
  t.after(reader.close);
  const { native, relay, restored } = await reader.read();
  if (other) {
    assert.ok(!JSON.stringify(restored).includes(other.secret), 'the actual sealed native snapshot never carries the foreign title');
    const scoped = relay.milestones.find(milestone => milestone.name === 'Cross-board privacy');
    assert.ok(scoped, 'the cross-board milestone remains visible');
    assert.ok(JSON.stringify(scoped).includes('unavailable'), 'the external reference is an unavailable obligation');
    assert.ok(!JSON.stringify(scoped).includes('foreign-parity'), 'the external project reference remains redacted');
  }
  /**
   * The declared inventory split into parts, each on its own linked fixture and child process, run at once.
   * Why: every operation is still published and compared against both full readers after its own mutation; only the
   * serial wait between independent boards goes, and the union of the parts must still equal every declared operation.
   */
  async function exerciseOperations() {
    const parts = OPERATION_PARTS;
    const [first, ...rest] = parts;
    // The first part starts at once on this board; every other part builds its own linked board while it runs.
    const results = await Promise.all([
      runOperationPart(t, box, link, session, first),
      ...rest.map(async part => {
        const other = await linkedParityBox(t);
        const linked = await linkedSession(other);
        return runOperationPart(t, other, linked.link, linked.session, part);
      }),
    ]);
    console.log('TIMINGS ' + JSON.stringify(results.map(r => r.timings)));
    const declared = results[0].declared;
    const covered = [...new Set(results.flatMap(result => result.covered))].sort();
    const missing = declared.filter(operation => !covered.includes(operation));
    assert.deepEqual(missing, [], `every declared native operation must pass the complete oracle; setup refusals=${JSON.stringify(results.map(result => result.setupRefusals))}`);
    return { covered, declared };
  }
  return { native, relay, restored, exercised: seeded.exercised, exerciseOperations };
}
