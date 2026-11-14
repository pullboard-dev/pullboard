/** @pullboard-test-loads packages/link/src/io/relay/machine.js */
/** Real private-board CLI and ordered-replay fixture controls [E11,E13,E14,E15,H16]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
} from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { appliedSequence } from '../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { engineReceipt } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { REFERENCE_ENGINE } from '../../../../packages/state/light.js';
import { preparePersonRequest } from '../../../../packages/person/light.js';
import { personRequestRecords } from '../../../../packages/link/index.js';
import {
  decodeBoardKey,
  seal,
} from '../../../../packages/kernel/index.js';
import { privateBoardPath } from '../../../../packages/seats/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { runFixtureGit } from './child.js';
import { submitFixture } from './board/submit.js';
import { enrollProtocolPhone } from './relay/enrollment.js';

/** Open only an explicitly named private fixture SQLite file and always close its connection. */
function withMoveBoard(file, work) {
  const board = openBoard(file);
  try { return work(board); }
  finally { store.closeBoard(board); }
}

/** Capture move-relevant native state, including reserved IDs, without local cache or heartbeat noise. */
function moveState(file) {
  return withMoveBoard(file, board => ({
    items: board.db.prepare('SELECT * FROM item ORDER BY item_id').all(),
    verdicts: board.db.prepare('SELECT * FROM verdict ORDER BY verdict_id').all(),
    moves: board.db.prepare("SELECT * FROM event WHERE event_kind IN ('rehome','rehome_reserved','rehome_import','rehome_applied') ORDER BY event_id").all(),
    bindings: board.db.prepare("SELECT * FROM board_meta WHERE meta_key GLOB 'item_rehome*' OR meta_key GLOB 'item_redirect:*' OR meta_key GLOB 'rehome_import:*' ORDER BY meta_key").all(),
    sequence: board.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='item'").get(),
  }));
}

/** Give the commit hooks a private Pullboard wrapper on the fixture PATH, once. */
function installPullboardWrapper(box) {
  const pullboard = join(box.env.PATH, 'pullboard');
  if (existsSync(pullboard)) return;
  const cli = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  writeFileSync(pullboard, `#!/bin/sh\nexec node "${cli}" "$@"\n`, { mode: 0o700 });
}

/** Enable the linked fixture's real local-first setting before testing acknowledged re-home moves. */
function enableRehomeOutbox(box, root) {
  const file = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { ...(config.relay ?? {}), outbox: true } }, null, 2) + '\n');
  installPullboardWrapper(box);
  runFixtureGit(['add', 'pullboard.json'], { cwd: root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore(config): queue relay moves while the relay is down'], { cwd: root, env: box.env });
}

/** Read only the key-free summary used by public relay status, never the sealed outbox payload. */
function outboxOperations(box) {
  const file = join(dirname(box.linkFile), 'relay-outbox.summary.json');
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).moves.map(move => move.operation);
}

/** Initialize a real local repository using the already authenticated fixture's isolated machine home. */
async function moveRepository(box, name, owner) {
  const root = join(box.root, '..', name);
  mkdirSync(root);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env: box.env });
  writeFileSync(join(root, 'README.md'), 'private board move fixture\n');
  runFixtureGit(['add', 'README.md'], { cwd: root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'fixture move repository'], { cwd: root, env: box.env });
  runFixtureGit(['remote', 'add', 'origin', `git@github.com:${owner}/web.git`], { cwd: root, env: box.env });
  const initialized = await box.cliAt(root, 'init', '--model', 'fixture-model');
  assert.equal(initialized.code, 0, JSON.stringify(initialized.document?.error));
  // init writes the repository's policy uncommitted; a sealed submit reads it from main's commit [V4,C7].
  if (runFixtureGit(['ls-files', 'pullboard.json'], { cwd: root, env: box.env }) === '') {
    installPullboardWrapper(box);
    runFixtureGit(['add', 'pullboard.json'], { cwd: root, env: box.env });
    runFixtureGit(['commit', '-q', '-m', 'chore(config): commit the generated policy'], { cwd: root, env: box.env });
  }
  return root;
}

/** Seed genuine native lifecycle records; this synthetic acceptance does not claim a gate or review ran. */
function privateMoveStatus(file, id, status, root, lane, commit) {
  return withMoveBoard(file, board => {
    board.gitRoot = root; // a private board lives outside .git, so name its repository for the sealed submit policy [V4,C7]
    const builder = store.register(board, { lane, path: join(root, `builder-${id}`), model: 'fixture-builder' });
    const reviewer = store.register(board, { lane, path: join(root, `reviewer-${id}`), model: 'fixture-reviewer' });
    const digest = `private-move-${id}`;
    store.claim(board, id, { agentId: builder, lane, leaseMs: 3_600_000, head: commit,
      freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, rows: [],
        policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } }), digest }) });
    if (status !== 'claimed') submitFixture(board, id, { agentId: builder, commit, tree: 'fixture-tree' });
    if (status === 'verified') store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT',
      note: 'Synthetic native acceptance for source attribution; no executed review is claimed.',
      head: commit, digest, policy: 'any' });
    return { builder, reviewer, commit, digest };
  });
}

/** Replay the exact destination operation in an isolated native replica, retaining all source attribution. */
function assertMoveReplay(file, record, id) {
  const document = withMoveBoard(file, exportBoard);
  const replica = openBoard(':memory:');
  try {
    importBoard(replica, document);
    const before = exportBoard(replica);
    assert.equal(store.applyRehomeItem(replica, record, { destinationAgentId: 'coordinator' }), id);
    assert.deepEqual(exportBoard(replica), before, 'same-source-MOVEID redelivery creates no item, verdict, event or receipt');
    const receipts = before.tables.board_meta.filter(row => row.meta_key.startsWith('relay_receipt_'))
      .map(row => JSON.parse(row.meta_value));
    const receipt = receipts.find(row => {
      const move = JSON.parse(row.move);
      return move.operation === 'applyRehomeItem' && move.args[0]?.moveId === record.moveId;
    });
    assert.ok(receipt, 'the CLI delivered this source MOVEID in a real ordered destination envelope');
    const move = JSON.parse(receipt.move);
    const outcome = applyEngineMove(replica, move, { sequence: receipt.sequence, at: new Date().toISOString() });
    assert.deepEqual(outcome, receipt.outcome, 'exact ordered replay returns the original receipt');
    assert.equal(outcome.result, id);
    assert.deepEqual(exportBoard(replica), before, 'exact ordered replay changes no native row');
  } finally { store.closeBoard(replica); }
}

/** Add a handled source reference through the real phone request, relay journal and native coordinator. */
async function authenticatedPersonAdd(box, root, { requestId, title, criterion, brief }) {
  const teamFile = join(root, '.git', 'pullboard', 'board.sqlite');
  const link = JSON.parse(readFileSync(join(root, '.git', 'pullboard', 'relay.json'), 'utf8'));
  const minimum = box.auth.minimumEngineVersion(link.board);
  assert.ok(ENGINE_VERSION >= minimum, 'the fixture client meets this linked board’s retained engine floor');
  const phone = await box.phoneSession();
  const headers = { authorization: 'Bearer ' + phone.token, 'x-pullboard-engine': String(ENGINE_VERSION) };
  const stateResponse = await fetch(box.origin + '/api/v2/boards/' + link.board + '/state', { headers });
  const stateReply = await stateResponse.json();
  assert.equal(stateResponse.status, 200, JSON.stringify(stateReply.error ?? {}));
  const state = stateReply.state;
  assert.ok(Number.isSafeInteger(state.sequence) && state.sequence >= 0, 'the snapshot supplies the event cursor');
  const eventsResponse = await fetch(box.origin + '/api/v1/boards/' + link.board + '/events?after=' + state.sequence, { headers });
  const eventsReply = await eventsResponse.json();
  assert.equal(eventsResponse.status, 200, JSON.stringify(eventsReply.error ?? {}));
  const prefix = eventsReply;
  assert.ok(Array.isArray(prefix.events), 'the relay returns ordered events after the snapshot cursor');
  const sequence = Math.max(state.sequence, ...prefix.events.map(event => event.event_id)) + 1;
  const intent = preparePersonRequest({ verb: 'add', args: { lane: box.lane, title, criterion, brief, route: 'strong' } }, requestId);
  const keyPath = join(box.env.PULLBOARD_HOME, 'relay-keys', link.board + '.key');
  const key = decodeBoardKey(readFileSync(keyPath, 'utf8').trim());
  const encrypted = await seal(key, new TextEncoder().encode(JSON.stringify(intent)), {
    boardId: link.board, kind: 'request', sequence,
  });
  const posted = await fetch(box.origin + '/api/v1/boards/' + link.board + '/requests', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence, sealed: Buffer.from(encrypted).toString('base64url') }),
  });
  assert.equal(posted.status, 200, 'the authenticated person request is appended to the relay journal');
  const accepted = await posted.json();
  assert.equal(accepted.event.kind, 'request');
  assert.equal(accepted.event.event_id, sequence);
  const executed = await box.cliAt(root, 'relay');
  assert.equal(executed.code, 0, JSON.stringify(executed.document?.error));
  return withMoveBoard(teamFile, board => {
    const request = personRequestRecords(board).find(record => record.id === requestId && !record.duplicateOf);
    assert.ok(request, 'the native board retained the authenticated request receipt');
    assert.equal(request.status, 'done');
    const intake = JSON.parse(request.received);
    assert.equal(intake.sender.kind, 'person');
    assert.equal(intake.sender.login, 'alice');
    const receipts = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key GLOB 'relay_receipt_*'").all()
      .map(row => JSON.parse(row.meta_value));
    const matching = receipts.filter(receipt => {
      const move = JSON.parse(receipt.move);
      return move.operation === 'addItem' && move.personRequest?.id === requestId
        && move.personRequest?.phase === 'execute' && move.args[0]?.title === title;
    });
    assert.equal(matching.length, 1, 'exactly one native add receipt fulfils the person request');
    const sourceReceipt = matching[0];
    const recordedMove = JSON.parse(sourceReceipt.move);
    assert.ok(recordedMove.engine >= REFERENCE_ENGINE, 'the accepted request uses checked-reference engine semantics');
    assert.equal(recordedMove.args[0].brief, brief, 'the ordered receipt is bound to the exact handled brief');
    assert.equal(sourceReceipt.outcome.result, request.result, 'the request result identifies the receipt’s source item');
    const event = board.db.prepare("SELECT event_by,event_detail FROM event WHERE event_kind='add' AND item_id=?").get(request.result);
    assert.equal(event.event_by, 'person', 'the native add is attributed to the person request');
    assert.equal(JSON.parse(event.event_detail).person, 'alice', 'the source event retains the authenticated person login');
    assert.equal(engineReceipt(board, recordedMove.id).outcome.result, request.result);
    return request.result;
  });
}

/** Supply only the one public GitHub issue author needed by this isolated relay fixture. */
function installReferenceAuthorFixture(box) {
  const path = join(box.env.PATH, 'gh');
  if (!existsSync(path)) {
    writeFileSync(path, [
      '#!/bin/sh',
      'if [ "$#" -eq 8 ] && [ "$1" = api ] && [ "$2" = --method ] && [ "$3" = GET ] && [ "$4" = repos/fixture/repository/issues/6 ] && [ "$5" = --header ] && [ "$6" = "Accept: application/vnd.github+json" ] && [ "$7" = --header ] && [ "$8" = "X-GitHub-Api-Version: 2022-11-28" ]; then',
      "  printf '%s\\n' '{\"user\":{\"login\":\"issue-author\"}}'",
      'else',
      '  exit 64',
      'fi',
    ].join('\n') + '\n');
    chmodSync(path, 0o700);
  }
}

/** Age an existing authenticated fixture seat observation without inventing an actor or shared event. */
function agePrivateHeartbeat(file, root) {
  const key = withMoveBoard(file, board => {
    const actor = store.agentAt(board, root);
    assert.ok(actor, 'the real private add already registered this checkout');
    assert.equal(heartbeatSeat(board, actor.agent_id), true, 'seed only this real private seat observation');
    return JSON.stringify([store.boardId(board), actor.agent_id]);
  });
  const db = new DatabaseSync(file + '.presence.sqlite');
  const at = new Date(Date.now() - 120_000).toISOString(); // budget: measured stale age only; no elapsed-time margin is asserted.
  try { assert.equal(db.prepare('UPDATE heartbeat SET at=? WHERE seat=?').run(at, key).changes, 1); } // budget: measured row count only; this seeds stale state and does not assert elapsed time.
  finally { db.close(); }
  return { key, at };
}

/** Require a real successful private command to refresh the deliberately stale local observation. */
function assertPrivateHeartbeat(file, before) {
  const db = new DatabaseSync(file + '.presence.sqlite', { readOnly: true });
  try {
    const row = db.prepare('SELECT at FROM heartbeat WHERE seat=?').get(before.key);
    assert.ok(row && Date.parse(row.at) > Date.parse(before.at), 'the private write refreshes its stale heartbeat');
  } finally { db.close(); }
}

/** Private local writes never acquire a relay receipt or publish their private board identity. */
function assertPrivateTransportIsolation(box, file) {
  withMoveBoard(file, board => {
    assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key GLOB 'relay_receipt_*'").get().n, 0,
      'private source operations have no ordered relay receipt');
    const id = store.boardId(board);
    assert.equal(box.calls.some(call => call.path.includes(id)), false, 'private board identity never addresses the shared relay');
  });
}

/** Distinct repository origins disambiguate private boards owned by the same signed-in person. */
async function privateHandleCollision(box, root, bobRoot, teamFile, localFile, openId) {
  const bobTeamFile = join(bobRoot, '.git', 'pullboard', 'board.sqlite');
  const bobPrivateFile = privateBoardPath(withMoveBoard(bobTeamFile, store.boardId), box.env.PULLBOARD_HOME);
  for (const title of ['other private one', 'other private two', 'other private open move']) {
    const added = await box.cliAt(bobRoot, 'add', box.lane, title, '--private');
    assert.equal(added.code, 0, JSON.stringify(added.document?.error));
  }
  assert.notEqual(withMoveBoard(localFile, store.boardId), withMoveBoard(bobPrivateFile, store.boardId));
  for (const file of [localFile, bobPrivateFile]) withMoveBoard(file, board => {
    const reference = JSON.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('private_board_reference').meta_value);
    assert.equal(reference.owner, 'alice', 'the same signed-in person owns both private boards');
  });
  const files = [localFile, teamFile, bobPrivateFile, bobTeamFile];
  const before = files.map(moveState);
  for (const [source, destination] of [['~web#3', 'acme/web'], [`acme/web#${openId}`, '~web']]) {
    const ambiguous = await box.cliAt(root, 'move', source, '--to', destination);
    assert.notEqual(ambiguous.code, 0);
    assert.equal(ambiguous.document.error.code, 'BOARD_REFERENCE');
    assert.match(ambiguous.document.error.message, /~acme\/web/u);
    assert.match(ambiguous.document.error.message, /~bob\/web/u);
  }
  assert.deepEqual(files.map(moveState), before, 'ambiguous private handles do not mutate either source or destination board');
  const moved = await box.cliAt(bobRoot, 'move', '~bob/web#3', '--to', 'bob/web');
  assert.equal(moved.code, 0, JSON.stringify(moved.document?.error));
  assert.equal(moved.document.source, '~bob/web#3');
  const record = moved.document.item;
  assert.equal(record.sourceBoardId, withMoveBoard(bobPrivateFile, store.boardId));
  withMoveBoard(bobTeamFile, board => assert.equal(store.getItem(board, record.destinationItemId).item_title, 'other private open move'));
  assertMoveReplay(bobTeamFile, record, record.destinationItemId);
}

/** Exercise real CLI handles and both move directions beside the original linked-device privacy controls. */
export async function privateBoardMoves(box, privateFile) {
  Object.assign(box.providerState, {
    signer: 'alice',
    people: { alice: { id: 7, permission: 'write' }, bob: { id: 8, permission: 'write' } },
    qualifiedRepositories: {
      'acme/web': { id: 201, installationId: 43,
        people: { alice: { id: 7, permission: 'write' } } },
      'bob/web': { id: 202, installationId: 44,
        people: { alice: { id: 7, permission: 'write' }, bob: { id: 8, permission: 'write' } } },
    },
  });
  const root = await moveRepository(box, 'acme-web', 'acme');
  const bobRoot = await moveRepository(box, 'bob-web', 'bob');
  await enrollProtocolPhone(box);
  const signedIn = await box.cli('relay', 'on', '--all', '--url', box.origin);
  assert.equal(signedIn.code, 0, 'the real machine sign-in writer records its GitHub login: ' + JSON.stringify(signedIn.document?.error));
  assert.equal(signedIn.document.paired, true, 'existing authenticated protocol enrollment avoids waiting for a new browser pairing');
  const owner = await box.script(`
    import { relayMachineOwner } from ${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)};
    const owner = relayMachineOwner();
    process.stdout.write(JSON.stringify({ account: owner.account, login: owner.login }));
  `);
  assert.equal(owner.code, 0);
  assert.deepEqual(owner.document, { account: '7', login: 'alice' }, 'the numeric account stays separate from its authenticated login');
  const addHeartbeat = agePrivateHeartbeat(privateFile, box.root);
  await settleRelayCalls(box);
  const callsBeforePrivateAdd = box.calls.length;
  const linkedPrivate = await box.cli('add', box.lane, 'private item delivered through the relay', '--private');
  assert.equal(linkedPrivate.code, 0);
  assert.equal(box.calls.length, callsBeforePrivateAdd, 'a successful private add makes no shared request or publication');
  assertPrivateHeartbeat(privateFile, addHeartbeat);
  assertPrivateTransportIsolation(box, privateFile);
  const sharedBeforeMove = withMoveBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'), exportBoard);
  assert.equal(JSON.stringify(sharedBeforeMove).includes('private item delivered through the relay'), false,
    'private add does not place its prose in shared native history');
  const linkedId = linkedPrivate.document.item.item_id;
  const moveHeartbeat = agePrivateHeartbeat(privateFile, box.root);
  let sourceAtDelivery = null;
  box.beforeNextMove(() => {
    assert.equal(withMoveBoard(privateFile, board => store.itemRedirect(board, linkedId)), null,
      'destination reservation precedes the durable private source move');
    box.beforeNextMove(() => {
      sourceAtDelivery = withMoveBoard(privateFile, board => store.itemRedirect(board, linkedId));
      assert.ok(sourceAtDelivery, 'the private source move is durable before destination delivery');
      box.refuseReads(true); // The real relay accepts delivery, then its event read refuses, as in relay-outbox.test.js.
    });
  });
  let interrupted;
  try { interrupted = await box.cli('move', `~repository#${linkedId}`, '--to', 'fixture/repository'); }
  finally { box.refuseReads(false); }
  assert.ok(sourceAtDelivery, 'the destination failure control was exercised after source commit');
  assert.equal(interrupted.code, 1);
  assert.equal(interrupted.document.error.code, 'REHOME_PENDING');
  assert.ok(interrupted.document.error.message.includes(sourceAtDelivery.moveId), 'the refusal names the already-recorded source MOVEID');
  assert.match(interrupted.document.error.message, /source move .* is recorded/u);
  assert.match(interrupted.document.error.message, /retry this same move and destination/u);
  assertPrivateHeartbeat(privateFile, moveHeartbeat);
  assertPrivateTransportIsolation(box, privateFile);
  withMoveBoard(privateFile, board => assert.equal(store.events(board).filter(event => event.event_kind === 'rehome' && event.item_id === linkedId).length, 1,
    'a later destination failure cannot duplicate the committed private source write'));
  const delivered = await box.cli('move', `~repository#${linkedId}`, '--to', 'fixture/repository');
  assert.equal(delivered.code, 0, JSON.stringify(delivered.document?.error));
  assert.equal(delivered.document.moveId, sourceAtDelivery.moveId, 'retry finishes the original source MOVEID');
  assert.equal(delivered.document.item.destinationItemId, sourceAtDelivery.destinationItemId, 'retry retains the original destination reservation');
  assertPrivateTransportIsolation(box, privateFile);
  const linkedDestination = delivered.document.item.destinationItemId;
  const shared = (await box.cli('export')).document.tables;
  assert.ok(shared.item.some(item => item.item_id === linkedDestination && item.item_title === 'private item delivered through the relay'),
    'the CLI destination operation reaches the real linked team board');
  assert.equal(shared.event.filter(event => event.event_kind === 'rehome_applied' && event.item_id === linkedDestination).length, 1);
  withMoveBoard(privateFile, board => {
    assert.equal(store.itemRedirect(board, linkedId).moveId, delivered.document.moveId);
    assert.equal(store.events(board).filter(event => event.event_kind === 'rehome' && event.item_id === linkedId).length, 1,
      'the private source records exactly one sequenced move');
  });

  const teamFile = join(root, '.git', 'pullboard', 'board.sqlite');
  const teamId = withMoveBoard(teamFile, store.boardId);
  const linkedTeamFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const localFile = privateBoardPath(teamId, box.env.PULLBOARD_HOME);
  enableRehomeOutbox(box, box.root);

  // If delivery loses its acknowledgment, the source redirect retains the exact reservation for retry.
  const interruptedPrivate = await box.cli('add', box.lane, 'private source waits for destination delivery', '--private');
  assert.equal(interruptedPrivate.code, 0, JSON.stringify(interruptedPrivate.document?.error));
  box.beforeNextMove(() => box.refuseMoves(true));
  const interruptedDelivery = await box.cli('move', `~fixture/repository#${interruptedPrivate.document.item.item_id}`, '--to', 'fixture/repository');
  box.refuseMoves(false);
  assert.notEqual(interruptedDelivery.code, 0);
  assert.equal(interruptedDelivery.document.error.code, 'REHOME_PENDING');
  const sourceDelivery = withMoveBoard(privateFile, board => store.itemRedirect(board, interruptedPrivate.document.item.item_id));
  assert.equal(sourceDelivery.moveId, interruptedDelivery.document.error.message.match(/source move ([A-Za-z0-9_-]+)/u)?.[1]);
  assert.ok(Number.isSafeInteger(sourceDelivery.destinationItemId) && sourceDelivery.destinationItemId > 0,
    'the destination reservation is a positive ordered ID');
  assert.equal(withMoveBoard(linkedTeamFile, board => board.db.prepare('SELECT 1 FROM item WHERE item_id=?')
    .get(sourceDelivery.destinationItemId)), undefined, 'a refused application creates no destination item');
  assert.deepEqual(outboxOperations(box), [], 'an interrupted destination application is never queued');
  const recoveredDelivery = await box.cli('move', `~fixture/repository#${interruptedPrivate.document.item.item_id}`, '--to', 'fixture/repository');
  assert.equal(recoveredDelivery.code, 0, JSON.stringify(recoveredDelivery.document?.error));
  assert.equal(recoveredDelivery.document.moveId, sourceDelivery.moveId);
  assert.equal(recoveredDelivery.document.item.destinationItemId, sourceDelivery.destinationItemId,
    'retry uses the original acknowledged reservation rather than selecting a new ID');
  assert.deepEqual(outboxOperations(box), [], 'the recovered application is not queued');

  // A private destination ID is local, but a linked team reservation cannot be chosen while the relay is down.
  await box.stopRelay();
  const pendingPrivate = await box.cli('add', box.lane, 'private source waits for a team reservation', '--private');
  assert.equal(pendingPrivate.code, 0, JSON.stringify(pendingPrivate.document?.error));
  const beforeReserveFailure = moveState(linkedTeamFile), beforePrivateReserveFailure = moveState(privateFile);
  const reserveOffline = await box.cli('move', `~fixture/repository#${pendingPrivate.document.item.item_id}`, '--to', 'fixture/repository');
  assert.notEqual(reserveOffline.code, 0);
  assert.equal(reserveOffline.document.error.code, 'RELAY_UNAVAILABLE');
  assert.match(reserveOffline.document.error.message, /retry this move when the relay is reachable/u);
  assert.deepEqual(moveState(linkedTeamFile), beforeReserveFailure, 'an unavailable reservation allocates no team ID');
  assert.deepEqual(moveState(privateFile), beforePrivateReserveFailure, 'an unavailable reservation leaves its private source unchanged');
  assert.deepEqual(outboxOperations(box), [], 'a reservation is refused instead of becoming a provisional outbox result');

  // A pending local add has only a provisional ID. Re-home must refuse it before reserving any destination ID.
  const provisional = await box.cli('add', box.lane, 'provisional item cannot be re-homed');
  assert.equal(provisional.code, 0, JSON.stringify(provisional.document?.error));
  const provisionalId = provisional.document.item.item_id;
  assert.deepEqual(outboxOperations(box), ['addItem'], 'the linked CLI keeps the unavailable add in its local outbox');
  const sourceState = moveState(linkedTeamFile), privateState = moveState(privateFile);
  const pendingRehome = await box.cli('move', `fixture/repository#${provisionalId}`, '--to', '~fixture/repository');
  assert.notEqual(pendingRehome.code, 0);
  assert.equal(pendingRehome.document.error.code, 'RELAY_OUTBOX_UNBOUND');
  assert.match(pendingRehome.document.error.message, /current item ID/u,
    'the refusal requires relay order and a fresh item lookup rather than guessing a remapped number');
  assert.deepEqual(moveState(linkedTeamFile), sourceState, 'a provisional source ID creates no source re-home record');
  assert.deepEqual(moveState(privateFile), privateState, 'a provisional source ID is refused before destination ID reservation');
  assert.deepEqual(outboxOperations(box), ['addItem'], 'the re-home never joins the provisional local outbox');
  await box.restartRelay();
  const synchronized = await box.cli('relay', 'status');
  assert.equal(synchronized.code, 0, JSON.stringify(synchronized.document?.error));
  assert.deepEqual(outboxOperations(box), [], 'the add receives relay order before a move can use its ID');
  const authoritative = await box.cli('show', String(provisionalId));
  assert.equal(authoritative.code, 0, JSON.stringify(authoritative.document?.error));
  assert.equal(authoritative.document.item_id, provisionalId, 'the current relay-authoritative ID is looked up explicitly');
  assert.equal(authoritative.document.item_title, 'provisional item cannot be re-homed', 'the relay lookup returns the original item identity');
  const movedProvisional = await box.cli('move', `fixture/repository#${authoritative.document.item_id}`, '--to', '~fixture/repository');
  assert.equal(movedProvisional.code, 0, JSON.stringify(movedProvisional.document?.error));
  assert.equal(movedProvisional.document.item.sourceItemId, provisionalId);
  assert.ok(movedProvisional.document.item.destinationItemId > pendingPrivate.document.item.item_id,
    'the acknowledged private reservation does not reuse the existing private item ID');
  assert.deepEqual(outboxOperations(box), [], 'neither source move nor destination application is queued');

  // A private destination reservation is local and durable, but a team source tombstone still needs relay order.
  const teamSource = await box.cli('add', box.lane, 'acknowledged source remains put while relay is offline');
  assert.equal(teamSource.code, 0, JSON.stringify(teamSource.document?.error));
  const synchronizedSource = await box.cli('relay', 'status');
  assert.equal(synchronizedSource.code, 0, JSON.stringify(synchronizedSource.document?.error));
  assert.deepEqual(outboxOperations(box), [], 'the team source receives relay order before the outage control');
  const authoritativeTeamSource = await box.cli('show', String(teamSource.document.item.item_id));
  assert.equal(authoritativeTeamSource.code, 0, JSON.stringify(authoritativeTeamSource.document?.error));
  assert.equal(authoritativeTeamSource.document.item_id, teamSource.document.item.item_id);
  const beforeOfflineSourceMove = moveState(linkedTeamFile);
  const beforeOfflineDestinationReservation = moveState(privateFile);
  await box.stopRelay();
  const unavailableSourceMove = await box.cli('move', `fixture/repository#${authoritativeTeamSource.document.item_id}`, '--to', '~fixture/repository');
  assert.notEqual(unavailableSourceMove.code, 0);
  assert.equal(unavailableSourceMove.document.error.code, 'RELAY_UNAVAILABLE');
  assert.match(unavailableSourceMove.document.error.message, /retry this move when the relay is reachable/u);
  assert.deepEqual(outboxOperations(box), [], 'a rehome source move is refused instead of being queued');
  withMoveBoard(linkedTeamFile, board => assert.equal(store.itemRedirect(board, authoritativeTeamSource.document.item_id), null,
    'no source tombstone is written without an acknowledged source move'));
  withMoveBoard(linkedTeamFile, board => assert.equal(store.getItem(board, authoritativeTeamSource.document.item_id).item_title,
    'acknowledged source remains put while relay is offline'));
  const afterOfflineDestinationReservation = moveState(privateFile);
  assert.deepEqual(afterOfflineDestinationReservation.items, beforeOfflineDestinationReservation.items,
    'the private reservation leaves every existing item unchanged');
  assert.deepEqual(afterOfflineDestinationReservation.verdicts, beforeOfflineDestinationReservation.verdicts,
    'the private reservation leaves every existing verdict unchanged');
  assert.ok((afterOfflineDestinationReservation.sequence?.seq ?? 0) > (beforeOfflineDestinationReservation.sequence?.seq ?? 0),
    'the private destination reservation may consume an ID without replacing an item');
  await box.restartRelay();
  await box.cli('relay', 'status');
  const movedAfterReconnect = await box.cli('move', `fixture/repository#${authoritativeTeamSource.document.item_id}`, '--to', '~fixture/repository');
  assert.equal(movedAfterReconnect.code, 0, JSON.stringify(movedAfterReconnect.document?.error));
  assert.equal(movedAfterReconnect.document.item.sourceItemId, authoritativeTeamSource.document.item_id);
  assert.ok(movedAfterReconnect.document.item.destinationItemId > (afterOfflineDestinationReservation.sequence?.seq ?? 0),
    'a consumed reservation ID is never reused after retry');
  assert.notDeepEqual(moveState(linkedTeamFile), beforeOfflineSourceMove, 'the source move is recorded only after relay order returns');
  assert.deepEqual(outboxOperations(box), [], 'the acknowledged move remains outside the outbox after recovery');

  for (const title of ['private one', 'private two', 'private open move', 'private accepted move', 'private claimed move', 'private submitted move']) {
    const added = await box.cliAt(root, 'add', box.lane, title, '--criterion', 'The private move keeps its source evidence.', '--private');
    assert.equal(added.code, 0, JSON.stringify(added.document?.error));
  }
  const beforeSource = moveState(localFile), beforeTeam = moveState(teamFile);
  for (const [source, destination] of [['~web#3', 'web'], ['web#3', '~web']]) {
    const ambiguous = await box.cliAt(root, 'move', source, '--to', destination);
    assert.notEqual(ambiguous.code, 0);
    assert.equal(ambiguous.document.error.code, 'BOARD_REFERENCE');
    assert.match(ambiguous.document.error.message, /acme\/web/u);
    assert.match(ambiguous.document.error.message, /bob\/web/u);
  }
  assert.deepEqual(moveState(localFile), beforeSource, 'ambiguous handles do not reserve or move a source item');
  assert.deepEqual(moveState(teamFile), beforeTeam, 'ambiguous handles do not mutate the destination');
  const moved = await box.cliAt(root, 'move', '~web#3', '--to', 'acme/web');
  assert.equal(moved.code, 0, JSON.stringify(moved.document?.error));
  assert.equal(moved.document.source, '~acme/web#3', 'the private qualifier is its repository origin, while the signed-in person remains owner metadata');
  const openRecord = moved.document.item;
  assert.equal(openRecord.sourceBoardId, withMoveBoard(localFile, store.boardId));
  assert.equal(openRecord.sourceItemId, 3);
  withMoveBoard(localFile, board => {
    assert.equal(store.itemRedirect(board, 3).moveId, moved.document.moveId);
    assert.throws(() => store.getItem(board, 3), error => error.code === 'ITEM_MOVED' && error.message.includes(moved.document.destination));
    assert.equal(store.events(board).filter(event => event.event_kind === 'rehome' && event.item_id === 3).length, 1);
  });
  const beforeRetry = moveState(teamFile);
  const retried = await box.cliAt(root, 'move', '~acme/web#3', '--to', 'acme/web');
  assert.equal(retried.code, 0, JSON.stringify(retried.document?.error));
  assert.equal(retried.document.moveId, moved.document.moveId);
  assert.equal(retried.document.destination, moved.document.destination);
  assert.deepEqual(moveState(teamFile), beforeRetry, 'retrying a source MOVEID does not duplicate destination rows or reservations');
  assertMoveReplay(teamFile, openRecord, openRecord.destinationItemId);
  await privateHandleCollision(box, root, bobRoot, teamFile, localFile, openRecord.destinationItemId);

  const commit = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env: box.env });
  const accepted = privateMoveStatus(localFile, 4, 'verified', root, box.lane, commit);
  const imported = await box.cliAt(root, 'move', '~acme/web#4', '--to', 'acme/web');
  assert.equal(imported.code, 0, JSON.stringify(imported.document?.error));
  const importedRecord = imported.document.item;
  withMoveBoard(teamFile, board => {
    const item = store.getItem(board, importedRecord.destinationItemId);
    assert.equal(item.item_status, 'verified');
    assert.equal(item.item_commit, accepted.commit);
    assert.equal(item.item_frozen_digest, accepted.digest);
    assert.equal(item.item_verified_by, accepted.reviewer);
    assert.deepEqual(store.verdictsFor(board, item.item_id), [], 'a source acceptance never becomes a destination-board verdict');
    assert.equal(item.item_rehome_import.sourceBoardId, importedRecord.sourceBoardId);
    assert.equal(item.item_rehome_import.moveId, imported.document.moveId);
    assert.equal(item.item_rehome_import.verdict.by, accepted.reviewer);
    assert.equal(item.item_rehome_import.attestedBy, 'coordinator');
  });
  assertMoveReplay(teamFile, importedRecord, importedRecord.destinationItemId);
  for (const [id, status] of [[5, 'claimed'], [6, 'submitted']]) {
    privateMoveStatus(localFile, id, status, root, box.lane, commit);
    const sourceBefore = moveState(localFile), destinationBefore = moveState(teamFile);
    const refused = await box.cliAt(root, 'move', `~acme/web#${id}`, '--to', 'acme/web');
    assert.notEqual(refused.code, 0);
    assert.equal(refused.document.error.code, 'REHOME_STATE', `${status} source work stays put`);
    assert.deepEqual(moveState(localFile), sourceBefore);
    assert.deepEqual(moveState(teamFile), destinationBefore, 'a refused source state allocates no destination ID');
  }
  const ordinary = await box.cliAt(root, 'add', box.lane, 'team item moving to private');
  assert.equal(ordinary.code, 0);
  const reverse = await box.cliAt(root, 'move', `acme/web#${ordinary.document.item.item_id}`, '--to', '~acme/web');
  assert.equal(reverse.code, 0, JSON.stringify(reverse.document?.error));
  const reverseId = reverse.document.item.destinationItemId;
  assert.ok(reverseId > 6, 'old private IDs are never reused');
  withMoveBoard(localFile, board => assert.equal(store.getItem(board, reverseId).item_title, 'team item moving to private'));

  const target = 'https://github.com/fixture/repository/issues/6';
  const carriedBrief = `Change: keep the source acknowledgement.\nReference: ${target} @issue-author`;
  installReferenceAuthorFixture(box);
  const carriedId = await authenticatedPersonAdd(box, root, { requestId: 'rehome-reference-valid-proof',
    title: 'Receipt-backed handled reference', criterion: 'Preserve checked source attribution.', brief: carriedBrief });
  const carried = await box.cliAt(root, 'move', `acme/web#${carriedId}`, '--to', '~acme/web');
  assert.equal(carried.code, 0, JSON.stringify(carried.document?.error));
  const carriedDestination = carried.document.item.destinationItemId;
  withMoveBoard(localFile, board => {
    assert.equal(store.getItem(board, carriedDestination).item_brief, carriedBrief,
      'a current-engine source receipt carries its checked handle and exact brief');
  });

  const staleBrief = `Change: original explanation.\nReference: ${target} @issue-author`;
  const currentBrief = `Change: revised explanation.\nReference: ${target} @issue-author`;
  const staleProofId = await authenticatedPersonAdd(box, root, { requestId: 'rehome-reference-stale-person-proof',
    title: 'Handled reference with later brief edit', criterion: 'Keep current source content.', brief: staleBrief });
  const edit = await box.cliAt(root, 'edit', String(staleProofId), '--brief', currentBrief);
  assert.equal(edit.code, 0, JSON.stringify(edit.document?.error));
  withMoveBoard(teamFile, board => {
    const receipt = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key GLOB 'relay_receipt_*'").all()
      .map(row => JSON.parse(row.meta_value)).find(candidate => {
        const move = JSON.parse(candidate.move);
        return move.operation === 'editItem' && move.args[0] === staleProofId && move.args[1]?.brief === currentBrief;
      });
    assert.ok(receipt, 'the ordinary edit has its own ordered source receipt');
    const recordedEdit = JSON.parse(receipt.move);
    assert.equal(recordedEdit.args[0], staleProofId);
    assert.equal(recordedEdit.args[1].brief, currentBrief);
    assert.equal(recordedEdit.args[1].referenceAuthority, undefined,
      'a signed-in editor does not carry authority to acknowledge the handled reference');
    assert.notEqual(recordedEdit.personRequest?.phase, 'execute',
      'the later edit is not an authenticated person acknowledgement request');
    const sourceEvent = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='edit' AND item_id=? ORDER BY event_id DESC LIMIT 1").get(staleProofId);
    assert.equal(JSON.parse(sourceEvent.event_detail).person, 'alice',
      'the signed-in sender login is not itself a reference-authority receipt');
  });
  const staleProof = await box.cliAt(root, 'move', `acme/web#${staleProofId}`, '--to', '~acme/web');
  assert.equal(staleProof.code, 0, JSON.stringify(staleProof.document?.error));
  withMoveBoard(localFile, board => {
    const importedItem = store.getItem(board, staleProof.document.item.destinationItemId);
    assert.match(importedItem.item_brief, /Reference: https:\/\/github\.com\/fixture\/repository\/issues\/6/u);
    assert.match(importedItem.item_brief, /Change: revised explanation\./u);
    assert.doesNotMatch(importedItem.item_brief, /@issue-author/u,
      'a same-item person receipt for an older brief cannot authorize the current handled marker');
  });

  const unreceiptedBrief = 'Change: keep the explanation.\nReference: https://example.com/private-source @PrivateAuthor';
  const privateHandled = await box.cliAt(root, 'add', box.lane, 'Private handled reference without team receipt',
    '--private', '--brief', unreceiptedBrief);
  assert.equal(privateHandled.code, 0, JSON.stringify(privateHandled.document?.error));
  const privateHandledId = privateHandled.document.item.item_id;
  assertPrivateTransportIsolation(box, localFile);
  withMoveBoard(localFile, board => assert.match(store.getItem(board, privateHandledId).item_brief, /@PrivateAuthor$/u));
  const downgraded = await box.cliAt(root, 'move', `~acme/web#${privateHandledId}`, '--to', 'acme/web');
  assert.equal(downgraded.code, 0, JSON.stringify(downgraded.document?.error));
  withMoveBoard(teamFile, board => {
    const importedItem = store.getItem(board, downgraded.document.item.destinationItemId);
    assert.match(importedItem.item_brief, /Reference: https:\/\/example\.com\/private-source/u);
    assert.match(importedItem.item_brief, /Change: keep the explanation\./u);
    assert.doesNotMatch(importedItem.item_brief, /@PrivateAuthor/u,
      'a private handled marker without a source receipt is preserved as an unhandled reference');
  });

  const oldEngineBrief = `Change: keep the legacy explanation.\nReference: ${target} @issue-author`;
  const legacyRoot = await moveRepository(box, 'legacy-web', 'legacy');
  const legacyTeamFile = join(legacyRoot, '.git', 'pullboard', 'board.sqlite');
  assert.equal(existsSync(join(legacyRoot, '.git', 'pullboard', 'relay.json')), false,
    'the historical fixture is deliberately unlinked and cannot submit an old-engine write to the current relay');
  const legacyPrivate = await box.cliAt(legacyRoot, 'add', box.lane, 'legacy private destination', '--private');
  assert.equal(legacyPrivate.code, 0, JSON.stringify(legacyPrivate.document?.error));
  const legacyPrivateFile = privateBoardPath(withMoveBoard(legacyTeamFile, store.boardId), box.env.PULLBOARD_HOME);
  const oldEngineId = withMoveBoard(legacyTeamFile, board => {
    const prepared = prepareEngineMove(board, 'addItem', [{ by: 'coordinator', lane: 'web',
      title: 'Historical handled reference with legacy receipt', criterion: 'Keep the old item content.',
      brief: oldEngineBrief, route: 'strong' }], { id: 'rehome-reference-old-engine-only' });
    const move = { ...prepared, engine: REFERENCE_ENGINE - 1 };
    const outcome = applyRelayMove(board, move, { sequence: appliedSequence(board) + 1,
      at: new Date().toISOString(), kind: 'move',
      sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } });
    assert.equal(outcome.error, undefined, JSON.stringify(outcome.error));
    const receipt = engineReceipt(board, move.id);
    assert.ok(receipt, 'the historical handled item has an ordered receipt');
    assert.ok(JSON.parse(receipt.move).engine < REFERENCE_ENGINE,
      'the receipt predates checked-reference semantics and cannot prove the handled marker');
    assert.equal(JSON.parse(receipt.move).args[0].brief, oldEngineBrief);
    assert.equal(receipt.outcome.result, outcome.result);
    return outcome.result;
  });
  const oldEngine = await box.cliAt(legacyRoot, 'move', `legacy/web#${oldEngineId}`, '--to', '~legacy/web');
  assert.equal(oldEngine.code, 0, JSON.stringify(oldEngine.document?.error));
  withMoveBoard(legacyPrivateFile, board => {
    const importedItem = store.getItem(board, oldEngine.document.item.destinationItemId);
    assert.match(importedItem.item_brief, /Reference: https:\/\/github\.com\/fixture\/repository\/issues\/6/u);
    assert.match(importedItem.item_brief, /Change: keep the legacy explanation\./u);
    assert.doesNotMatch(importedItem.item_brief, /@issue-author/u,
      'a pre-reference-engine receipt cannot confer handled status');
  });

  const legacyBrief = `Change: keep the older explanation.\nReference: ${target} @issue-author`;
  const unprovenId = withMoveBoard(legacyTeamFile, board => {
    const oldAdd = prepareEngineMove(board, 'addItem', [{ by: 'coordinator', lane: 'web',
      title: 'Historical handled reference without person proof', criterion: 'Keep the legacy item.',
      brief: legacyBrief, route: 'strong' }], { id: 'rehome-reference-old-add' });
    const oldMove = { ...oldAdd, engine: REFERENCE_ENGINE - 1 };
    const oldOutcome = applyRelayMove(board, oldMove,
      { sequence: appliedSequence(board) + 1, at: new Date().toISOString(), kind: 'move',
        sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } });
    assert.equal(oldOutcome.error, undefined, JSON.stringify(oldOutcome.error));
    const oldReceipt = engineReceipt(board, oldMove.id);
    assert.ok(oldReceipt, 'the legacy add has an ordered source receipt');
    assert.ok(JSON.parse(oldReceipt.move).engine < REFERENCE_ENGINE, 'the legacy receipt predates checked-reference semantics');
    assert.equal(JSON.parse(oldReceipt.move).args[0].brief, legacyBrief);
    assert.equal(oldReceipt.outcome.result, oldOutcome.result);
    const edit = prepareEngineMove(board, 'editItem', [oldOutcome.result, { agentId: 'coordinator',
      brief: legacyBrief, referenceAuthors: [{ target, author: 'issue-author' }] }], { id: 'rehome-reference-unproven-edit' });
    const editOutcome = applyRelayMove(board, edit, { sequence: appliedSequence(board) + 1,
      at: new Date().toISOString(), kind: 'move',
      sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } });
    assert.equal(editOutcome.error, undefined, JSON.stringify(editOutcome.error));
    const editReceipt = engineReceipt(board, edit.id);
    assert.ok(editReceipt, 'the current brief receipt exists but has no person-authority proof');
    const recordedEdit = JSON.parse(editReceipt.move);
    assert.ok(recordedEdit.engine >= REFERENCE_ENGINE);
    assert.equal(recordedEdit.args[0], oldOutcome.result, 'the non-person receipt refers to this exact source item');
    assert.equal(recordedEdit.args[1].brief, legacyBrief, 'the non-person receipt covers the exact current brief');
    const event = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='edit' AND item_id=? ORDER BY event_id DESC LIMIT 1").get(oldOutcome.result);
    assert.equal(JSON.parse(event.event_detail).person, undefined, 'the receipt did not originate from the authenticated person');
    return oldOutcome.result;
  });
  const unproven = await box.cliAt(legacyRoot, 'move', `legacy/web#${unprovenId}`, '--to', '~legacy/web');
  assert.equal(unproven.code, 0, JSON.stringify(unproven.document?.error));
  withMoveBoard(legacyPrivateFile, board => {
    const importedItem = store.getItem(board, unproven.document.item.destinationItemId);
    assert.match(importedItem.item_brief, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
    assert.match(importedItem.item_brief, /Change: keep the older explanation\./u);
    assert.doesNotMatch(importedItem.item_brief, /@issue-author/u,
      'a receipt without authenticated person authority cannot preserve the handled marker');
  });

  const fresh = await box.cliAt(root, 'add', box.lane, 'new private item after moves', '--private');
  assert.equal(fresh.code, 0);
  assert.ok(fresh.document.item.item_id > reverseId);
  withMoveBoard(localFile, board => assert.equal(store.itemRedirect(board, 3).moveId, moved.document.moveId,
    'the old source ID keeps its permanent redirect after later adds'));
}

/**
 * Wait until the fixture relay's call count holds still for two seconds.
 * The previous command's background sender may still be talking to the relay, and a baseline taken mid-send miscounts [E11].
 */
export async function settleRelayCalls(box) {
  for (let steady = 0, seen = -1; steady < 20; await new Promise(done => { const probe = setTimeout(done, 100); probe.unref?.(); })) {
    steady = box.calls.length === seen ? steady + 1 : 0;
    seen = box.calls.length;
  }
}
