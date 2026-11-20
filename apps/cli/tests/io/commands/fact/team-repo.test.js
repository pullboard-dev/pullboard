import { viewApiPorts } from '../../../../../view/index.js';
import { apiBoardOpeners } from '../../../fixtures/board.js';
import { fixtureProjectPolicy } from '../../../fixtures/testkit.js';
import * as linkStore from '../../../../../../packages/store/index.js';
/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js packages/store/src/io/exchange.js packages/person/src/io/signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  boardLinkRequest,
  after,
  applyEngineMove,
  assert,
  consent,
  exportBoard,
  fetchFresh,
  importBoard,
  linkRelay,
  main,
  prepareEngineMove,
  serveApi,
  refusalDocument,
  signedBoard,
  store,
  submitFixture,
  test,
  writeFileSync,
} from '../../../fixtures/scenarios/team.js';
import { join } from 'node:path';
import { CROSS_REPO_DEPENDENCY_ENGINE } from '../../../../../../packages/state/light.js';
const { openBoard } = apiBoardOpeners;

test('cli.journeys-fact-team-repo.an-item-waits-across-repos: an item waits across repos [B24,H16]', async t => {
  /** A private board clock makes exact canonical replay comparisons deterministic. */
  const clock = { now: () => new Date('2026-10-25T00:00:00Z') };
  const parent = signedBoard(t, 'app', clock);
  const child = signedBoard(t, 'service', clock);
  const local = parent.board, foreign = child.board;
  writeFileSync(join(parent.root, 'pullboard.json'), JSON.stringify({ name: 'app', project: 'fixture', gate: 'true', lanes: { web: { owns: ['web/'] } } }));
  writeFileSync(join(parent.root, 'SPEC.md'), '# Synthetic fixture\n\n- B24 [approved, must] Cross-repo fixture. | gate: test/team.test.js\n');
  parent.git('add', 'pullboard.json', 'SPEC.md');
  parent.git('commit', '-q', '-m', 'fixture: configure the private dependency API');
  // The foreign board seals its own accepted policy on submit, so its repository commits one too (NO_POLICY otherwise).
  fixtureProjectPolicy(child.root, { config: { name: 'service', project: 'fixture', gate: 'true', lanes: { web: { owns: ['web/'] } } } });
  child.git('add', 'pullboard.json');
  child.git('commit', '-q', '-m', 'fixture: configure the private prerequisite board');
  for (const box of [parent, child]) {
    store.register(box.board, { lane: 'coordinator', path: box.root });
    store.register(box.board, { lane: 'web', path: join(box.root, 'synthetic-builder') });
  }
  const localId = store.addItem(local, { by: 'coordinator', lane: 'web', title: 'Local same-number item' });
  const foreignId = store.addItem(foreign, { by: 'coordinator', lane: 'web', title: 'Foreign prerequisite' });
  assert.equal(localId, foreignId, 'independent real Git/SQLite boards intentionally reuse the same item number');
  const dependent = store.addItem(local, { by: 'coordinator', lane: 'web', title: 'Wait for service', after: [`service#${foreignId}`] });
  assert.equal(store.getItem(local, dependent).item_after, `service#${foreignId}`);
  /** Explicit synthetic frozen bar; native moves below do not claim that this fixture ran a gate. */
  const freeze = item => ({ text: item.item_title, digest: `fixture:${item.item_title}` });
  /** Record an actual native verified transition, with a clearly synthetic build receipt. */
  function accept(board, id, root, title) {
    const box = root === parent.root ? parent : child;
    const commit = box.git('rev-parse', 'HEAD').trim();
    const tree = box.git('rev-parse', 'HEAD^{tree}').trim();
    store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 60_000, head: commit, freeze });
    submitFixture(board, id, { agentId: 'web-1', commit, tree });
    const reviewer = store.register(board, { lane: 'web', path: join(root, 'synthetic-reviewer') });
    store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', reason: 'CRITERION_MET',
      note: 'synthetic board-state fixture; no gate execution', head: commit, digest: `fixture:${title}`, policy: 'any' });
  }
  accept(local, localId, parent.root, 'Local same-number item');
  store.merged(local, localId, { agentId: 'coordinator', commit: parent.git('rev-parse', 'HEAD').trim() });
  /** Assert the native claim guard and pull queue name the owning repository. */
  function blocked(id, label) {
    assert.throws(() => store.claim(local, id, { agentId: 'web-1', lane: 'web', leaseMs: 60_000, freeze }),
      error => error.code === 'BLOCKED' && error.message.includes(label));
    assert.ok(store.nextFor(local, { agentId: 'web-1', lane: 'web' }).reasons.some(reason => reason.includes(label)));
  }
  blocked(dependent, 'service#1');
  const missing = store.addItem(local, { by: 'coordinator', lane: 'web', title: 'Missing board', after: ['missing#999'] });
  blocked(missing, 'missing#999');
  const api = linkStore;
  const transportApi = linkStore;
  const { createSshBoardLinkAuthority } = linkStore;
  const { createBoardLinkCapability } = linkStore;
  const { generateBoardKey } = await import('../../../../../../packages/kernel/src/logic/seal.js');
  const authority = createSshBoardLinkAuthority([parent, child]);
  const record = await consent(api, authority, parent, child, 'dependency');
  await api.applyBoardLink(local, record, authority);
  await api.applyBoardLink(foreign, record, authority);
  const relay = await linkRelay(t, [parent, child], authority);
  const sender = transportApi.createBoardLinkRelayTransport(relay.states.get(child.reference.boardId), { request: boardLinkRequest });
  const receiver = transportApi.createBoardLinkRelayTransport(relay.states.get(parent.reference.boardId), { request: boardLinkRequest });
  await sender.publish(record);
  const capability = createBoardLinkCapability(record, await generateBoardKey());
  /** Send only actual child item states through the established authenticated E32 transport. */
  async function announce(position) {
    const context = { linkId: record.linkId, generation: record.generation, sourceBoardId: child.reference.boardId,
      destinationBoardId: parent.reference.boardId, position, correlationId: `state-${position}`,
      rows: [{ board: child.reference.boardId, id: foreignId, state: store.getItem(foreign, foreignId).item_status }] };
    await transportApi.deliverBoardState(foreign, context, { authority, capability, transport: sender });
    const deliveries = (await receiver.read()).deliveries;
    await transportApi.receiveBoardState(local, deliveries.at(-1), { authority, capability });
  }
  await announce(1);
  blocked(dependent, 'service#1');
  const builds = [];
  const localApi = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, port: 0, runCommand: main, stateDetail: 'full',
    projects: () => [{ root: parent.root, name: 'app', project: 'fixture', added: '2026-10-25T00:00:00Z' }],
    onItemBuild: entry => builds.push(entry.itemId) });
  t.after(() => localApi.close());
  const address = new URL(localApi.url);
  /** Observe the real cached API projection without substituting an item builder. */
  async function readState() {
    const response = await fetchFresh(`${address.origin}/api/v1/boards/${parent.reference.boardId}/state?detail=full`,
      { headers: { 'x-pullboard-key': address.searchParams.get('k') } });
    const document = await response.json();
    assert.equal(response.status, 200, JSON.stringify(document));
    return document.state;
  }
  await readState();
  builds.length = 0;
  await readState();
  assert.deepEqual(builds, [], 'unchanged API reads actually reuse the warm item cache');
  accept(foreign, foreignId, child.root, 'Foreign prerequisite');
  blocked(dependent, 'service#1');
  await announce(2);
  await readState();
  assert.ok(builds.includes(dependent), 'an authenticated global state announcement rebuilds its cached foreign dependents');
  const replica = openBoard(':memory:', clock);
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(local));
  const options = { agentId: 'web-1', lane: 'web', leaseMs: 60_000, freeze };
  assert.equal(store.nextFor(local, { agentId: 'web-1', lane: 'web' }).item.item_id, dependent);
  assert.equal(store.nextFor(replica, { agentId: 'web-1', lane: 'web' }).item.item_id, dependent);
  const move = prepareEngineMove(local, 'claim', [dependent, options]);
  assert.ok(move.engine >= CROSS_REPO_DEPENDENCY_ENGINE, 'older replicas cannot flatten a foreign-dependent claim');
  const ordered = { sequence: 1, at: clock.now().toISOString() };
  assert.deepEqual(applyEngineMove(local, move, ordered), applyEngineMove(replica, move, ordered), 'one ordered claim returns the same receipt on both replicas');
  assert.equal(store.getItem(local, dependent).item_status, 'claimed');
  assert.equal(store.getItem(replica, dependent).item_status, 'claimed', 'replica uses canonical received state, not a local registry or foreign-board path');
  assert.deepEqual(exportBoard(replica), exportBoard(local), 'same canonical state and claim produce exact replica rows and event IDs');
  await readState();
  builds.length = 0;
  const revoked = await api.revokeBoardLink(record, parent.reference.boardId, authority, { by: parent.by, key: parent.key });
  await api.applyBoardLink(local, revoked, authority);
  await readState();
  assert.ok(builds.includes(dependent), 'a canonical link revocation invalidates cached foreign dependency status');
});
