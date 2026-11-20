import { request as boardLinkRequest } from '../../../../packages/link/index.js';
import { createRelayJournal } from '../../../relay/index.js';
import {
  signedBoard,
  consent,
  linkRelay,
} from '../../tests/fixtures/board/link.js';
/** Bilateral board links disclose only authorized state and retain real SSH consent [E32,H16,H17]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';

test('cli.journeys-relay-inbox.opening-a-relay-journal-installs-delivery: opening a relay journal installs delivery storage before the first link envelope [E32,H16,H17]', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-link-opener-'));
  const boardId = 'a'.repeat(32);
  const file = join(directory, boardId + '.journal.sqlite');
  let journal = null;
  t.after(() => { journal?.close(); rmSync(directory, { recursive: true, force: true }); });
  journal = createRelayJournal({ directory, boardId });
  const db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='board_link_delivery'").get().n, 1,
      'opening the store installs every delivery table, before any append');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM board_link_delivery').get().n, 0);
  } finally { db.close(); }
  journal.append(1, Buffer.from('opaque existing bytes'), 'move', { kind: 'agent', userId: 'fixture', agent: 'fixture-agent' });
  journal.close(); journal = null;
  const old = new DatabaseSync(file);
  try { old.exec('DROP TABLE board_link_delivery'); } finally { old.close(); }
  journal = createRelayJournal({ directory, boardId });
  assert.equal(journal.after()[0].bytes.toString(), 'opaque existing bytes', 'additive initialization preserves existing journal bytes');
  const upgraded = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM board_link_delivery').get().n, 0); }
  finally { upgraded.close(); }
});

test('cli.journeys-relay-inbox.a-signed-two-sided-link-carries: a signed two-sided link carries only its disclosure mode and refuses a cycle [E32,H16,H17]', async t => {
  const loaded = await import('../../../../packages/store/index.js').then(api => ({ api }), error => ({ error }));
  assert.equal(loaded.error, undefined, 'the shared production board-link boundary must exist');
  const api = loaded.api;
  const { createSshBoardLinkAuthority } = await import('../../../../packages/store/index.js');
  const parent = signedBoard(t, 'parent');
  const child = signedBoard(t, 'child');
  const second = signedBoard(t, 'second');
  const authority = createSshBoardLinkAuthority([parent, child, second]);
  const record = await consent(api, authority, parent, child, 'parent-child');
  await assert.rejects(api.verifyBoardLink({ ...record, approvals: record.approvals.slice(0, 1) }, authority),
    error => error.code === 'BOARD_LINK_AUTH', 'one endpoint cannot supply bilateral consent');
  await assert.rejects(api.verifyBoardLink(record, createSshBoardLinkAuthority([])), error => error.code === 'BOARD_LINK_AUTH');
  await assert.rejects(api.verifyBoardLink({ ...record, generation: 2 }, authority),
    error => error.code === 'BOARD_LINK_AUTH', 'a new generation cannot reuse old signatures');
  const forged = structuredClone(record);
  forged.approvals[0].signature = 'not an SSH signature';
  await assert.rejects(api.verifyBoardLink(forged, authority), error => error.code === 'BOARD_LINK_AUTH');
  assert.match(record.approvals[0].signature, /BEGIN SSH SIGNATURE/u, 'the existing SSH authority signs real consent');
  assert.match(record.approvals[1].signature, /BEGIN SSH SIGNATURE/u);
  assert.equal(readFileSync(join(parent.root, '.pullboard', 'signers'), 'utf8').includes('parent'), true);
  await api.applyBoardLink(parent.board, record, authority);
  await api.applyBoardLink(child.board, record, authority);
  assert.deepEqual(api.readBoardLinks(parent.board), [record]);
  assert.deepEqual(api.resolveBoardReference([parent.reference, child.reference], 'fixture/child'), child.reference);
  assert.deepEqual(api.resolveBoardReference([parent.reference, child.reference], { boardId: child.reference.boardId }), child.reference);
  assert.throws(() => api.resolveBoardReference([parent.reference, { ...child.reference, handle: parent.reference.handle }], 'fixture/parent'),
    error => error.code === 'BOARD_REFERENCE', 'qualified display names must be unambiguous in the authorized inventory');
  const announcement = api.boardStateAnnouncement(parent.board, { linkId: record.linkId,
    sourceBoardId: child.reference.boardId, destinationBoardId: parent.reference.boardId,
    generation: 1, position: 7,
    rows: [{ board: child.reference.boardId, id: 8, state: 'claimed', title: 'private title', criterion: 'private criterion', note: 'private note' }] });
  assert.deepEqual(announcement.rows, [{ board: child.reference.boardId, id: 8, state: 'claimed' }]);
  assert.equal(JSON.stringify(announcement).includes('private'), false);
  assert.equal(announcement.generation, 1);
  assert.equal(announcement.position, 7);
  assert.deepEqual(api.discloseBoardState('counts', announcement.rows), { claimed: 1 });
  assert.deepEqual(api.discloseBoardState('nothing', announcement.rows), []);
  const secondParent = await consent(api, authority, second, child, 'second-child', 'counts');
  await api.applyBoardLink(parent.board, secondParent, authority);
  assert.equal(api.readBoardLinks(parent.board).length, 2, 'the graph supports more than one parent');
  const cycle = await consent(api, authority, child, parent, 'child-parent');
  await assert.rejects(api.applyBoardLink(parent.board, cycle, authority), error => error.code === 'BOARD_LINK_CYCLE');
  assert.equal(api.readBoardLinks(parent.board).length, 2, 'refused cycles never persist');
  const revoked = await api.revokeBoardLink(record, child.reference.boardId, authority, { by: child.by, key: child.key });
  await api.applyBoardLink(parent.board, revoked, authority);
  assert.throws(() => api.boardStateAnnouncement(parent.board, { linkId: record.linkId,
    sourceBoardId: child.reference.boardId, destinationBoardId: parent.reference.boardId,
    generation: 1, position: 8, rows: [] }), error => error.code === 'BOARD_LINK_INACTIVE');
  await assert.rejects(api.applyBoardLink(parent.board, record, authority), error => error.code === 'BOARD_LINK_CONFLICT',
    'replaying old consent cannot undo a signed revocation');
  const renewed = await consent(api, authority, parent, child, record.linkId, 'nothing', 2);
  await api.applyBoardLink(parent.board, renewed, authority);
  assert.deepEqual(api.boardStateAnnouncement(parent.board, { linkId: record.linkId, generation: 2,
    sourceBoardId: child.reference.boardId, destinationBoardId: parent.reference.boardId,
    position: 9, rows: [{ board: child.reference.boardId, id: 8, state: 'claimed', title: 'private' }] }).rows, []);
});

test('cli.journeys-relay-inbox.sealed-board-link-delivery-authenticates-both: sealed board-link delivery authenticates both boards and retains exact retries after restart [E32,H16,H17]', async t => {
  const loaded = await import('../../../../packages/store/index.js').then(api => ({ api }), error => ({ error }));
  assert.equal(loaded.error, undefined, 'the common authenticated delivery dispatcher must exist');
  const transportApi = loaded.api;
  const api = await import('../../../../packages/store/index.js');
  const { createSshBoardLinkAuthority } = await import('../../../../packages/store/index.js');
  const { createBoardLinkCapability } = await import('../../../../packages/store/index.js');
  const { generateBoardKey, seal, unseal } = await import('../../../../packages/kernel/src/logic/seal.js');
  const parent = signedBoard(t, 'parent');
  const child = signedBoard(t, 'child');
  const authority = createSshBoardLinkAuthority([parent, child]);
  const record = await consent(api, authority, parent, child, 'sealed-link');
  await api.applyBoardLink(parent.board, record, authority);
  await api.applyBoardLink(child.board, record, authority);
  const box = await linkRelay(t, [parent, child], authority);
  assert.throws(() => transportApi.createBoardLinkRelayTransport(box.states.get(child.reference.boardId), { request: null }), /authenticated request port/u);
  const sender = transportApi.createBoardLinkRelayTransport(box.states.get(child.reference.boardId), { request: boardLinkRequest });
  const receiver = transportApi.createBoardLinkRelayTransport(box.states.get(parent.reference.boardId), { request: boardLinkRequest });
  await sender.publish(record);
  const linkKey = await generateBoardKey();
  const capability = createBoardLinkCapability(record, linkKey);
  const parentKey = await generateBoardKey();
  const privateParent = await seal(parentKey, Buffer.from('unrelated private parent content'),
    { boardId: parent.reference.boardId, kind: 'snapshot', sequence: 0 });
  assert.equal(Buffer.from(await unseal(parentKey, privateParent,
    { boardId: parent.reference.boardId, kind: 'snapshot', sequence: 0 })).toString(), 'unrelated private parent content');
  await assert.rejects(unseal(linkKey, privateParent,
    { boardId: parent.reference.boardId, kind: 'snapshot', sequence: 0 }), error => error.code === 'SEAL_AUTH_FAILED',
    'a child’s per-link key cannot open other parent content');
  const context = { linkId: record.linkId, generation: 1, sourceBoardId: child.reference.boardId,
    destinationBoardId: parent.reference.boardId, position: 10, correlationId: 'state-10',
    rows: [{ board: child.reference.boardId, id: 1, state: 'claimed', title: 'must stay private' }] };
  const ports = { authority, capability, transport: sender };
  const receipt = await transportApi.deliverBoardState(child.board, context, ports);
  assert.deepEqual(await transportApi.deliverBoardState(child.board, context, ports), receipt, 'a retry returns the same durable outcome');
  await box.restart();
  assert.deepEqual(await transportApi.deliverBoardState(child.board, context, ports), receipt, 'a restart does not duplicate delivery');
  const messages = await receiver.read();
  assert.equal(messages.deliveries.length, 1);
  const delivered = messages.deliveries[0];
  assert.deepEqual(await sender.send(delivered.envelope), receipt, 'the restarted HTTP dispatcher returns its durable retry receipt');
  assert.equal((await receiver.read()).deliveries.length, 1, 'an actual HTTP retry does not append another envelope');
  const plain = await capability.open(delivered.envelope);
  assert.deepEqual(plain.rows, [{ board: child.reference.boardId, id: 1, state: 'claimed' }]);
  assert.equal(JSON.stringify(plain).includes('must stay private'), false);
  const received = await transportApi.receiveBoardState(parent.board, delivered, { authority, capability });
  const eventCount = parent.board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  assert.deepEqual(await transportApi.receiveBoardState(parent.board, delivered, { authority, capability }), received);
  assert.equal(parent.board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, eventCount, 'consumer retry makes no second event');
  await assert.rejects(capability.open({ ...delivered.envelope, position: 11 }), error => error.code === 'SEAL_AUTH_FAILED');
  await assert.rejects(capability.open({ ...delivered.envelope, correlationId: 'other' }), error => error.code === 'BOARD_LINK_FORMAT');
  await assert.rejects(sender.send({ ...delivered.envelope, sourceBoardId: '0'.repeat(32) }), error => error.code === 'BOARD_LINK_AUTH');
  await assert.rejects(sender.send(await capability.seal('stale-9', { ...plain, position: 9 })),
    error => error.code === 'BOARD_LINK_REPLAY', 'fresh correlation IDs cannot replay an older source position');
  await assert.rejects(sender.send(await capability.seal('state-10', plain)), error => error.code === 'BOARD_LINK_CONFLICT',
    'the same correlation cannot replace its retained ciphertext');
  const stored = transportApi.readReceivedBoardState(parent.board, context);
  stored.rows[0].state = 'withdrawn';
  assert.equal(transportApi.readReceivedBoardState(parent.board, context).rows[0].state, 'claimed', 'reads return detached state');
  const usedBytes = await box.storedBytes();
  await box.restart({ accountStorageBytes: usedBytes + 1 });
  const next = { ...context, position: 11, correlationId: 'quota-11' };
  await assert.rejects(transportApi.deliverBoardState(child.board, next, ports), error => error.code === 'ACCOUNT_STORAGE_LIMIT');
  assert.equal((await receiver.read()).deliveries.length, 1, 'quota refusal rolls back the incoming envelope');
  assert.equal(await box.storedBytes(), usedBytes, 'refused delivery contributes no retained bytes');
  await box.restart();
  await transportApi.deliverBoardState(child.board, next, ports);
  assert.equal((await receiver.read()).deliveries.length, 2, 'the unchanged durable outbox can retry after quota recovery');
  await assert.rejects(transportApi.deliverBoardState(child.board, { ...context,
    rows: [{ board: child.reference.boardId, id: 1, state: 'submitted' }] }, ports), error => error.code === 'BOARD_LINK_CONFLICT');
  await assert.rejects(box.request(box.states.get(child.reference.boardId),
    '/api/v1/boards/' + parent.reference.boardId + '/link-deliveries', {}, { ignoreRelayEnvironmentToken: true }),
    error => error.code === 'TOKEN_BOARD', 'a child token cannot read a parent inbox');
  const revoked = await api.revokeBoardLink(record, parent.reference.boardId, authority, { by: parent.by, key: parent.key });
  await receiver.publish(revoked);
  await assert.rejects(transportApi.deliverBoardState(child.board, { ...context, correlationId: 'state-11', position: 11 }, ports),
    error => error.code === 'BOARD_LINK_INACTIVE', 'authoritative revocation blocks a source whose local catalog is stale');
  for (const [generation, mode] of [[2, 'counts'], [3, 'nothing']]) {
    const renewed = await consent(api, authority, parent, child, record.linkId, mode, generation);
    await api.applyBoardLink(child.board, renewed, authority);
    await api.applyBoardLink(parent.board, renewed, authority);
    await sender.publish(renewed);
    const nextContext = { ...context, generation, position: generation, correlationId: 'mode-' + mode };
    await assert.rejects(transportApi.deliverBoardState(child.board, nextContext, ports), error => error.code === 'BOARD_LINK_AUTH',
      'a prior generation capability cannot seal new consent');
    await assert.rejects(transportApi.deliverBoardState(child.board, nextContext, { authority, transport: sender }),
      error => error.code === 'BOARD_LINK_AUTH', 'missing sealing authority never falls back to plaintext');
    const scoped = createBoardLinkCapability(renewed, await generateBoardKey());
    await transportApi.deliverBoardState(child.board, nextContext, { authority, capability: scoped, transport: sender });
    const delivery = (await receiver.read()).deliveries.at(-1);
    const allowed = await scoped.open(delivery.envelope);
    assert.deepEqual(allowed.rows, mode === 'counts' ? { claimed: 1 } : []);
    assert.equal(JSON.stringify(allowed).includes('must stay private'), false);
    await transportApi.receiveBoardState(parent.board, delivery, { authority, capability: scoped });
    scoped.close();
    await assert.rejects(scoped.open(delivery.envelope), error => error.code === 'BOARD_LINK_AUTH');
  }
  capability.close();
});
