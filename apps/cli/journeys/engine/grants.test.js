/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js */
/** Computed grants preserve actual authority and exact historical replicas [E21,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  appliedSequence,
  applyEngineMove,
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/src/io/engine.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { unpackRelease } from '../../tests/fixtures/release/archive.js';
import { submitFixture as submitBoardStateFixture } from '../../tests/fixtures/board/submit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Open the real board owned by the private fixture for exactly one observation. */
function withBoard(root, action) {
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  try { return action(board); }
  finally { store.closeBoard(board); }
}

/** Preserve the real CLI command's refusal or complete successful output. */
function run(box, root, ...args) {
  const result = box.run(root, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return result.out;
}

test('clause 1: an agent grant narrows at claim and expires identically on independent replicas [E21]', () => {
  const box = helpers.project();
  for (const title of ['Claimed work', 'Other work']) {
    run(box, box.repo, 'add', 'web', title, '--specs', 'G1', '--route', 'strong', '--check', 'test -f web/grant-proof');
  }
  run(box, box.repo, 'add', 'api', 'Other lane', '--specs', 'G2', '--route', 'strong', '--check', 'test -f api/grant-proof');
  const fresh = join(box.dir, 'fresh-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', fresh, 'main');
  run(box, fresh, 'join', 'web');
  const freshActor = withBoard(box.repo, board => store.listAgents(board).find(agent => agent.agent_path === fresh).agent_id);
  run(box, box.web, 'claim', '1');
  const actor = withBoard(box.repo, board => store.listAgents(board).find(agent => agent.agent_path === box.web).agent_id);
  const held = withBoard(box.repo, board => store.getItem(board, 1));
  const snapshot = withBoard(box.repo, exportBoard);
  const peer = join(box.dir, 'grant-replica');
  box.git(box.dir, 'clone', '-q', box.repo, peer);
  withBoard(peer, board => importBoard(board, snapshot));
  const roots = [box.repo, peer];
  const during = new Date(Date.parse(held.item_lease_until) - 1000).toISOString();
  const expired = new Date(Date.parse(held.item_lease_until) + 1).toISOString();
  /** Replay one sealed public engine move on both real SQLite replicas at its ordered receipt time. */
  const replay = (operation, args, at = during) => {
    const move = withBoard(box.repo, board => prepareEngineMove(board, operation, args));
    const outcomes = roots.map(root => withBoard(root, board => applyEngineMove(board, move,
      { sequence: appliedSequence(board) + 1, at })));
    assert.deepEqual(outcomes[0], outcomes[1], 'the same move has the same public result on both replicas');
    return outcomes[0];
  };
  /** Facts remain communication; escalation supplies the state-change grant witness. */
  const fact = (item, text, at, by = actor) => replay('appendFact', [item, { agentId: by, kind: 'note', text }], at);
  /** Escalation changes item state and must stay inside the computed grant. */
  const change = (item, note, at, by = actor) => replay('escalate', [item, { agentId: by, note }], at);
  assert.equal(fact(1, 'Own claimed item remains writable').error, undefined, 'positive own-item communication reached the engine');
  const before = roots.map(root => withBoard(root, board => store.getItem(board, 2)));
  const outside = change(2, 'This must not change another item');
  assert.equal(outside.error?.code, 'AGENT_GRANT_ITEM', 'claim narrows item mutations even inside the same lane');
  assert.deepEqual(roots.map(root => withBoard(root, board => store.getItem(board, 2))), before,
    'a refused state change cannot modify either replica');
  assert.equal(change(1, 'The expired lease no longer authorizes a move', expired).error?.code,
    'AGENT_GRANT_EXPIRED', 'ordered receipt time, not the receiving machine clock, ends the grant');
  // Administrative communication and release cannot be trapped behind the grant being reported.
  assert.equal(replay('shout', [{ from: actor, to: 'coordinator', text: 'My claim expired; arranging the next work.', lanes: ['web', 'api'] }], expired).error,
    undefined, 'ordinary coordination remains available after expiry');
  assert.equal(replay('release', [1, actor, 'Done with this claim.', 'OTHER'], expired).error, undefined);
  assert.equal(change(1, 'Release does not revive an expired grant', expired).error?.code, 'AGENT_GRANT_EXPIRED',
    'a fresh claim is required after expiry even after administrative release');
  assert.equal(change(3, 'An agent cannot mutate another lane', expired, freshActor).error?.code, 'AGENT_GRANT_LANE',
    'a fresh unclaimed seat still has only its registered lane');
});

test('clause 1: an agent grant narrows at claim without changing old receipts or permitting an old-engine bypass [E21,H16]', async t => {
  const { AGENT_GRANT_ENGINE: agentGrantEngine } = await import('../../../../packages/state/src/logic/engines/agent-grant-engine.js');
  const box = helpers.project();
  const clock = { now: () => new Date('2026-10-01T00:00:00.000Z') };
  const boards = ['legacy-authority.sqlite', 'legacy-peer.sqlite'].map(name => openBoard(join(box.dir, name), clock));
  t.after(() => boards.forEach(board => store.closeBoard(board)));
  const legacy = agentGrantEngine - 1;
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  /** Apply the same actual public engine record on both private replicas. */
  const apply = (operation, args, engine = legacy) => {
    const move = prepareEngineMove(boards[0], operation, args);
    move.engine = engine;
    const sequence = appliedSequence(boards[0]) + 1;
    const outcomes = boards.map(board => applyEngineMove(board, move, { sequence, at: clock.now().toISOString() }));
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.equal(outcomes[0].error, undefined, JSON.stringify(outcomes[0]));
    return { move, sequence, outcome: outcomes[0] };
  };
  apply('register', [{ lane: 'coordinator', path: box.repo, model: 'fixture-model' }]);
  const actor = apply('register', [{ lane: 'web', path: box.web, model: 'fixture-model' }]).outcome.result;
  const other = apply('register', [{ lane: 'web', path: join(box.dir, 'legacy-other-seat'), model: 'fixture-model' }]).outcome.result;
  for (const title of ['First', 'Second']) apply('addItem', [{ by: 'coordinator', lane: 'web', title,
    criterion: 'A real file must exist', specIds: [], check: 'test -f grant-proof' }]);
  /** Freeze an actual private Git revision; replicas receive only the canonical frozen value. */
  const freeze = item => {
    const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion,
      check: item.item_check, rows: [], policy: { version: 1, commit: head, verify: { policy: 'any', family: 'off' } } });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  };
  const options = { agentId: actor, lane: 'web', leaseMs: 60_000, freeze };
  apply('claim', [1, options]);
  const prior = apply('appendFact', [2, { agentId: actor, kind: 'note', text: 'Legacy behavior stays recorded.' }]);
  const forged = prepareEngineMove(boards[0], 'escalate', [2, { agentId: actor, note: 'Old engine cannot bypass the new claim.' }]);
  forged.engine = legacy;
  const oldPeer = prepareEngineMove(boards[0], 'escalate', [1, { agentId: other, note: 'Another old seat must understand the new item grant.' }]);
  oldPeer.engine = legacy;
  const oldTextPeer = prepareEngineMove(boards[0], 'escalate', ['1', { agentId: other, note: 'Numeric text cannot hide the newly claimed target from an old engine.' }]);
  oldTextPeer.engine = legacy;
  apply('claim', [1, options], agentGrantEngine);
  for (const board of boards) {
    const before = store.itemThread(board, 2);
    assert.deepEqual(applyEngineMove(board, prior.move, { sequence: prior.sequence, at: clock.now().toISOString() }),
      prior.outcome, 'an acknowledged legacy outcome is returned unchanged after activation');
    assert.throws(() => applyEngineMove(board, forged, { sequence: appliedSequence(board) + 1, at: clock.now().toISOString() }),
      error => error.code === 'RELAY_MOVE' && error.message.includes(String(agentGrantEngine)),
      'a freshly sealed old-engine move cannot bypass new-claim authority');
    assert.throws(() => applyEngineMove(board, oldPeer, { sequence: appliedSequence(board) + 1, at: clock.now().toISOString() }),
      error => error.code === 'RELAY_MOVE' && error.message.includes(String(agentGrantEngine)),
      'another legacy seat cannot interpret a newly claimed item under old grant semantics');
    assert.throws(() => applyEngineMove(board, oldTextPeer, { sequence: appliedSequence(board) + 1, at: clock.now().toISOString() }),
      error => error.code === 'RELAY_MOVE' && error.message.includes(String(agentGrantEngine)),
      'the same target expressed as numeric text still requires the new grant engine');
    assert.deepEqual(store.itemThread(board, 2), before, 'neither old receipt replay nor a forged old move adds a fact');
  }
});


test('clause 1: an agent grant narrows at claim without trapping its own handoff facts [E21,B3]', () => {
  const box = helpers.project();
  for (const title of ['Claimed work', 'Unrelated work']) {
    run(box, box.repo, 'add', 'web', title, '--specs', 'G1', '--route', 'strong', '--check', 'test -f web/grant-proof', '--wait');
  }
  run(box, box.web, 'claim', '1');
  const actor = withBoard(box.repo, board => store.listAgents(board).find(agent => agent.agent_path === box.web).agent_id);
  const held = withBoard(box.repo, board => store.getItem(board, 1));
  // With no registered runner a baseline stays pending and its worker has exited (add --wait) without writing, so no
  // detached writer can advance only one replica after the prefix is cloned [C7,#3851].
  for (const id of [1, 2]) {
    const baseline = withBoard(box.repo, board => store.getItem(board, id).item_check_baseline);
    assert.ok(baseline, 'each setup item retains its baseline observation');
    assert.equal(baseline.result, 'pending', 'with no runner a setup baseline stays pending, so no worker writes after replica export');
  }
  const snapshot = withBoard(box.repo, exportBoard);
  const peer = join(box.dir, 'handoff-grant-replica');
  box.git(box.dir, 'clone', '-q', box.repo, peer);
  withBoard(peer, board => importBoard(board, snapshot));
  const roots = [box.repo, peer];
  const during = new Date(Date.parse(held.item_lease_until) - 1000).toISOString();
  const expired = new Date(Date.parse(held.item_lease_until) + 1).toISOString();
  /** Apply one genuine engine record at the same ordered time on independent databases. */
  const replay = (operation, args, at = during) => {
    const move = withBoard(box.repo, board => prepareEngineMove(board, operation, args));
    const outcomes = roots.map(root => withBoard(root, board => applyEngineMove(board, move,
      { sequence: appliedSequence(board) + 1, at })));
    assert.deepEqual(outcomes[0], outcomes[1]);
    return outcomes[0];
  };
  assert.equal(replay('openHandoff', [{ agentId: actor }]).error, undefined, 'a claim does not trap channel creation');
  const channels = roots.map(root => withBoard(root, board => board.db.prepare(
    "SELECT item_id FROM event WHERE event_by=? AND event_kind='handoff-open' ORDER BY event_id DESC LIMIT 1").get(actor).item_id));
  assert.equal(channels[0], channels[1]);
  /** Handoff and ordinary item facts both remain available without state-change authority. */
  const fact = (item, text, at) => replay('appendFact', [item, { agentId: actor, kind: 'note', text }], at);
  assert.equal(fact(channels[0], 'Context for the incoming seat').error, undefined,
    'the live build claim cannot block facts on its own handoff channel');
  assert.equal(fact(2, 'Findings also belong on ordinary items').error, undefined);
  assert.equal(fact(channels[0], 'More context after the build lease ended', expired).error, undefined);
  assert.equal(fact(2, 'Expiry does not block findings', expired).error, undefined);
});


test('clause 1: an agent grant narrows at claim for accepted numeric-text item ids [E21,H16]', () => {
  const box = helpers.project();
  for (const title of ['Claimed work', 'Other work']) {
    run(box, box.repo, 'add', 'web', title, '--specs', 'G1', '--route', 'strong', '--check', 'test -f web/grant-proof', '--wait');
  }
  run(box, box.web, 'claim', '1');
  const actor = withBoard(box.repo, board => store.listAgents(board).find(agent => agent.agent_path === box.web).agent_id);
  const held = withBoard(box.repo, board => store.getItem(board, 1));
  // With no runner no baseline worker writes at all, so none can write only the source after this replica is copied [C7,#3851].
  // The public synchronous path finishes both setup observations before capturing the prefix.
  for (const id of [1, 2]) {
    const baseline = withBoard(box.repo, board => store.getItem(board, id).item_check_baseline);
    assert.ok(baseline, 'each setup item retains its baseline observation');
    assert.equal(baseline.result, 'pending', 'no runner: no setup baseline can append after replica export');
  }
  const snapshot = withBoard(box.repo, exportBoard);
  const peer = join(box.dir, 'text-id-grant-replica');
  box.git(box.dir, 'clone', '-q', box.repo, peer);
  withBoard(peer, board => importBoard(board, snapshot));
  const roots = [box.repo, peer];
  const during = new Date(Date.parse(held.item_lease_until) - 1000).toISOString();
  const expired = new Date(Date.parse(held.item_lease_until) + 1).toISOString();
  /** Keep the public engine argument bytes while both replicas resolve the same native row. */
  const change = (item, note, at = during) => {
    const move = withBoard(box.repo, board => prepareEngineMove(board, 'escalate', [item, { agentId: actor, note }]));
    const outcomes = roots.map(root => withBoard(root, board => applyEngineMove(board, move,
      { sequence: appliedSequence(board) + 1, at })));
    assert.deepEqual(outcomes[0], outcomes[1]);
    return outcomes[0];
  };
  const before = roots.map(root => withBoard(root, board => store.itemThread(board, 2)));
  for (const item of ['2', '02', '2.0', ' 2 ']) {
    assert.equal(change(item, 'An alternate spelling does not enlarge authority').error?.code, 'AGENT_GRANT_ITEM',
      `the existing target ${JSON.stringify(item)} is still outside the claim`);
  }
  assert.deepEqual(roots.map(root => withBoard(root, board => store.itemThread(board, 2))), before,
    'numeric-text refusals add no item facts on either replica');
  assert.equal(change('1', 'Text cannot extend an expired lease', expired).error?.code, 'AGENT_GRANT_EXPIRED');
  assert.equal(change('999999', 'A missing target stays missing', expired).error?.code, 'NO_ITEM');
  assert.equal(change('not-an-id', 'Malformed text keeps its existing refusal', expired).error?.code, 'NO_ITEM');
  assert.equal(change('1', 'Accepted numeric text still names the own item').error, undefined,
    'a state change must preserve the existing accepted item-id form');
});

/** Real Git and two private SQLite replicas; seeded acceptances are lifecycle fixtures, not executed gates. */
test('clause 1: an agent grant narrows at claim without trapping its own verdict withdrawal [E21,V2,V6,H16]', t => {
  const box = helpers.project();
  let instant = Date.parse('2026-10-24T00:00:00Z');
  const clock = { now: () => new Date(instant) };
  const boards = ['withdraw-grant-primary.sqlite', 'withdraw-grant-peer.sqlite']
    .map(name => openBoard(join(box.dir, name), clock, { gitRoot: box.repo }));
  t.after(() => boards.forEach(board => store.closeBoard(board)));
  const primary = boards[0];
  store.register(primary, { lane: 'coordinator', path: box.repo });
  const builder = store.register(primary, { lane: 'web', path: box.web, route: 'strong', parent: 'withdraw-builder', session: 'builder-child' });
  const reviewer = store.register(primary, { lane: 'tests', path: join(box.dir, 'withdraw-reviewer'), route: 'strong', parent: 'withdraw-reviewer', session: 'reviewer-child' });
  const stranger = store.register(primary, { lane: 'tests', path: join(box.dir, 'withdraw-stranger'), route: 'strong', parent: 'withdraw-stranger', session: 'stranger-child' });
  /** Supply the ordinary frozen criterion for this explicitly synthetic lifecycle setup. */
  const freeze = item => ({ text: item.item_title, digest: `withdraw:${item.item_id}` });
  const prior = store.addItem(primary, { by: 'coordinator', lane: 'tests', title: 'Earlier reviewer build' });
  const priorClaim = store.claim(primary, prior, { agentId: reviewer, lane: 'tests', leaseMs: 1000, freeze });
  const commit = box.git(box.repo, 'rev-parse', 'HEAD');
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  /** Create a current, immutable acceptance through the public board lifecycle. */
  function accepted(title) {
    const id = store.addItem(primary, { by: 'coordinator', lane: 'web', title });
    store.claim(primary, id, { agentId: builder, lane: 'web', leaseMs: 60_000, freeze });
    submitBoardStateFixture(primary, id, { agentId: builder, commit, tree });
    store.reserveReview(primary, id, { agentId: reviewer, leaseMs: 60_000, policy: 'any' });
    store.verify(primary, id, { agentId: reviewer, decision: 'ACCEPT', policy: 'any', head: commit,
      digest: store.getItem(primary, id).item_frozen_digest, note: 'Private lifecycle state only; no gate execution claimed.' });
    return id;
  }
  const own = accepted('Acceptance held by the different-lane reviewer');
  const control = accepted('Coordinator withdrawal positive control');
  instant += 1001;
  assert.ok(priorClaim.leaseUntil < clock.now().toISOString(), 'the earlier build lease really expired');
  assert.equal(store.getItem(primary, prior).item_status, 'open', 'the normal reader also treats that claim as expired');
  const original = store.verdictsFor(primary, own)[0];
  importBoard(boards[1], exportBoard(primary));
  /** One ordinary ordered move has the same outcome on both independent SQLite replicas. */
  function replay(operation, args) {
    const move = prepareEngineMove(primary, operation, args);
    const outcomes = boards.map(board => applyEngineMove(board, move,
      { sequence: appliedSequence(board) + 1, at: clock.now().toISOString() }));
    assert.deepEqual(outcomes[0], outcomes[1], 'the two replicas agree on the actual engine result');
    return outcomes[0];
  }
  const positive = replay('reopen', [control, { agentId: 'coordinator', withdrawVerdict: true,
    note: 'Positive control of the existing withdrawal lifecycle' }]);
  assert.equal(positive.error, undefined, 'the fixture supports a valid current verdict withdrawal');
  const conflict = replay('reopen', [own, { agentId: reviewer, conflict: { files: ['web/page.js'], trunk: commit },
    note: 'Conflict administration is not a reviewer exception' }]);
  assert.ok(conflict.error, 'a reviewer cannot substitute conflict reopening for its own verdict withdrawal');
  const withdrawn = replay('reopen', [String(own), { agentId: reviewer, withdrawVerdict: true,
    note: 'The reviewer corrects its own current acceptance after its old claim expired' }]);
  assert.equal(withdrawn.error, undefined, 'own verdict withdrawal remains review administration across lanes and expired build claims');
  for (const board of boards) {
    assert.equal(store.getItem(board, own).item_status, 'open');
    const verdict = store.verdictsFor(board, own).find(row => row.verdict_id === original.verdict_id);
    assert.equal(verdict.withdrawn, true);
    assert.equal(verdict.verdict_commit, original.verdict_commit, 'the acceptance continues to name its original commit');
    assert.equal(verdict.verdict_note, original.verdict_note, 'withdrawal never rewrites the original proof note');
  }
  const unrelated = replay('reopen', [control, { agentId: stranger, withdrawVerdict: true, note: 'Not this seat’s verdict' }]);
  assert.ok(unrelated.error, 'the exception gives a stranger no reopening authority');
});


/** Append-only findings are communication, not authority to change item state. */
test('clause 1: an agent grant narrows at claim but any joined seat can append attributed findings on every replica [E21,H16]', () => {
  const box = helpers.project();
  for (const title of ['Claimed work', 'Other work']) {
    run(box, box.repo, 'add', 'web', title, '--specs', 'G1', '--route', 'strong', '--check', 'test -f web/grant-proof');
  }
  run(box, box.repo, 'add', 'api', 'Different lane', '--specs', 'G2', '--route', 'strong', '--check', 'test -f api/grant-proof');
  const fresh = join(box.dir, 'finding-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', fresh, 'main');
  run(box, fresh, 'join', 'web');
  const freshActor = withBoard(box.repo, board => store.listAgents(board).find(agent => agent.agent_path === fresh).agent_id);
  run(box, box.web, 'claim', '1');
  const actor = withBoard(box.repo, board => store.listAgents(board).find(agent => agent.agent_path === box.web).agent_id);
  const held = withBoard(box.repo, board => store.getItem(board, 1));
  const snapshot = withBoard(box.repo, exportBoard);
  const peer = join(box.dir, 'findings-replica');
  box.git(box.dir, 'clone', '-q', box.repo, peer);
  withBoard(peer, board => importBoard(board, snapshot));
  const roots = [box.repo, peer];
  const during = new Date(Date.parse(held.item_lease_until) - 1000).toISOString();
  const expired = new Date(Date.parse(held.item_lease_until) + 1).toISOString();
  /** Apply a genuine fact record on both private boards and inspect its public attribution. */
  const finding = (item, by, at, text) => {
    const move = withBoard(box.repo, board => prepareEngineMove(board, 'appendFact',
      [item, { agentId: by, kind: 'note', text }]));
    const outcomes = roots.map(root => withBoard(root, board => applyEngineMove(board, move,
      { sequence: appliedSequence(board) + 1, at })));
    assert.deepEqual(outcomes[0], outcomes[1], 'independent replicas agree on the public result');
    assert.equal(outcomes[0].error, undefined, `${text}: ${JSON.stringify(outcomes[0])}`);
    const threads = roots.map(root => withBoard(root, board => store.itemThread(board, item)));
    assert.deepEqual(threads[0], threads[1], 'the attributed finding is the same on both replicas');
    assert.ok(threads[0].some(entry => entry.type === 'fact' && entry.text === text && entry.by === by), 'the attributed finding is actually recorded');
  };
  finding(1, actor, during, 'Positive own-item finding');
  finding(2, actor, during, 'A different claim cannot block a finding');
  finding(3, freshActor, during, 'An unclaimed seat may report a different lane');
  finding(2, actor, expired, 'An expired build claim cannot block a finding');
  finding(3, actor, expired, 'No review reservation is required for a finding');
});


/** The activation boundary is an ordered engine prefix, not a client opening the database. */
test('clause 1: an agent grant narrows at claim after the recorded engine high-water mark [E21,H16]', async t => {
  const { AGENT_GRANT_ENGINE: agentGrantEngine } = await import('../../../../packages/state/src/logic/engines/agent-grant-engine.js');
  const box = helpers.project();
  const directory = join(box.dir, 'actual-pre-grant-writer');
  mkdirSync(directory);
  unpackRelease('e4b7c30d674cde73803f8e8cb3f53fb2f9f62621', directory);
  const oldStore = await import(pathToFileURL(join(directory, 'src/board.js')).href);
  const oldEngine = await import(pathToFileURL(join(directory, 'src/engine.js')).href);
  const oldExchange = await import(pathToFileURL(join(directory, 'src/exchange.js')).href);
  const old = oldStore.openBoard(':memory:');
  const replicas = [openBoard(':memory:'), openBoard(':memory:')];
  t.after(() => { oldStore.closeBoard(old); replicas.forEach(board => store.closeBoard(board)); });
  let sequence = 0;
  const at = new Date().toISOString();
  /** The accepted old writer records actual legacy move bytes and outcomes before activation. */
  const recordOld = (operation, args) => {
    const move = oldEngine.prepareEngineMove(old, operation, args);
    const receipt = { sequence: ++sequence, at };
    const outcome = oldEngine.applyEngineMove(old, move, receipt);
    assert.equal(outcome.error, undefined, JSON.stringify(outcome));
    return { move, receipt, outcome };
  };
  recordOld('register', [{ lane: 'coordinator', path: box.repo }]);
  const actor = recordOld('register', [{ lane: 'web', path: box.web }]).outcome.result;
  recordOld('addItem', [{ by: 'coordinator', lane: 'web', title: 'Legacy unclaimed work', criterion: 'Keep old history.' }]);
  const acknowledged = recordOld('appendFact', [1, { agentId: actor, kind: 'note', text: 'Recorded before activation.' }]);
  const snapshot = oldExchange.exportBoard(old);
  assert.ok(snapshot.tables.event.filter(event => ['join', 'claim', 'renew'].includes(event.event_kind))
    .every(event => JSON.parse(event.event_detail).grantEngine === undefined), 'the old writer emits no future marker');
  const frozen = JSON.stringify({ title: 'Legacy unclaimed work', criterion: 'Keep old history.', check: '', rows: [] });
  const staleClaim = oldEngine.prepareEngineMove(old, 'claim', [1, { agentId: actor, lane: 'web', leaseMs: 60_000,
    freeze: () => ({ text: frozen, digest: createHash('sha256').update(frozen).digest('hex') }) }]);
  const staleAdd = oldEngine.prepareEngineMove(old, 'addItem', [{ by: actor, lane: 'web', title: 'Fresh old-engine item', criterion: 'Must not bypass activation.' }]);
  assert.ok(staleClaim.engine < agentGrantEngine);
  for (const board of replicas) importBoard(board, snapshot);
  const activation = prepareEngineMove(replicas[0], 'shout', [{ from: 'coordinator', to: actor, text: 'The modern engine is now recorded.', lanes: ['web'] }]);
  assert.ok(activation.engine >= agentGrantEngine);
  const activationReceipt = { sequence: sequence + 1, at };
  const activated = replicas.map(board => applyEngineMove(board, activation, activationReceipt));
  assert.deepEqual(activated[0], activated[1]);
  assert.equal(activated[0].error, undefined);
  for (const board of replicas) {
    assert.deepEqual(applyEngineMove(board, acknowledged.move, acknowledged.receipt), acknowledged.outcome,
      'the acknowledged pre-activation receipt replays byte-for-byte after activation');
    const before = appliedSequence(board);
    for (const move of [staleClaim, staleAdd]) {
      assert.throws(() => applyEngineMove(board, move, { sequence: before + 1, at }),
        error => error.code === 'RELAY_MOVE' && error.message.includes(String(agentGrantEngine)),
        'a newly ordered old-engine move cannot use wholly unmarked legacy seats or targets');
      assert.equal(appliedSequence(board), before, 'a version refusal leaves the ordered position retryable');
    }
    assert.equal(store.getItem(board, 1).item_status, 'open');
  }
});



test('clause 1: an agent grant narrows at claim without losing its submitted attempt receipt [E21,H16]', t => {
  const box = helpers.project();
  const clock = { now: () => new Date('2026-10-24T00:00:00Z') };
  const boards = ['attempt-primary.sqlite', 'attempt-peer.sqlite'].map(name => openBoard(join(box.dir, name), clock, { gitRoot: box.repo }));
  t.after(() => boards.forEach(board => store.closeBoard(board)));
  const primary = boards[0];
  store.register(primary, { lane: 'coordinator', path: box.repo });
  const agentId = store.register(primary, { lane: 'web', path: box.web, route: 'strong', parent: 'attempt-builder', session: 'attempt-child' });
  const id = store.addItem(primary, { by: 'coordinator', lane: 'web', title: 'Completed native work' });
  const freeze = item => ({ text: item.item_title, digest: `attempt:${item.item_id}` });
  store.claim(primary, id, { agentId, lane: 'web', leaseMs: 60_000, freeze });
  // Lifecycle state only: this fixture does not claim an executed check or an acceptance.
  submitBoardStateFixture(primary, id, { agentId, commit: box.git(box.repo, 'rev-parse', 'HEAD'), tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') });
  const before = store.getItem(primary, id);
  assert.equal(before.item_status, 'submitted');
  assert.equal(before.item_owner, agentId, 'submitted history retains its builder attribution');
  assert.equal(primary.db.prepare("SELECT COUNT(*) AS n FROM item WHERE item_owner=? AND item_status='claimed'").get(agentId).n, 0,
    'successful submit ended the active claim before the runner records its attempt');
  importBoard(boards[1], exportBoard(primary));
  const move = prepareEngineMove(primary, 'recordAttempt', [id, { agentId, n: 1, seconds: 2, result: 'green' }]);
  const outcomes = boards.map(board => applyEngineMove(board, move, { sequence: appliedSequence(board) + 1, at: clock.now().toISOString() }));
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0].error, undefined, 'the authenticated append-only attempt is allowed after successful submit');
  for (const board of boards) {
    assert.deepEqual(store.getItem(board, id), before, 'recording a result does not change item authority or state');
    const rows = board.db.prepare("SELECT event_by,event_detail FROM event WHERE event_kind='attempt' AND item_id=?").all(id);
    assert.deepEqual(rows.map(row => ({ ...row })), [{ event_by: agentId, event_detail: JSON.stringify({ n: 1, seconds: 2, result: 'green', model: 'unknown' }) }]);
  }
  const foreignAttempt = prepareEngineMove(primary, 'recordAttempt', [id, { agentId, n: 2, seconds: 1, result: 'red' }]);
  const foreign = boards.map(board => applyRelayMove(board, foreignAttempt, {
    sequence: appliedSequence(board) + 1, at: clock.now().toISOString(), kind: 'move',
    sender: { kind: 'agent', userId: 'fixture-user', agent: 'foreign-agent' },
  }));
  assert.deepEqual(foreign[0], foreign[1]);
  assert.equal(foreign[0].error.code, 'RELAY_SENDER_MISMATCH', 'append-only exemption never lets another authenticated seat supply this actor');
  for (const board of boards) {
    assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='attempt' AND item_id=?").get(id).n, 1);
    assert.deepEqual(store.getItem(board, id), before);
  }
  const edit = prepareEngineMove(primary, 'editItem', [id, { agentId, brief: 'claim-free state mutation' }]);
  const refused = boards.map(board => applyEngineMove(board, edit, { sequence: appliedSequence(board) + 1, at: clock.now().toISOString() }));
  assert.deepEqual(refused[0], refused[1]);
  assert.equal(refused[0].error.code, 'AGENT_GRANT_EXPIRED', 'the append-only record never restores a mutation grant');
});
