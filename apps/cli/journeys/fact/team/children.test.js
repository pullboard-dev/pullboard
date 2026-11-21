/** A parent item names each child's board, id and state from the boards below, and its replica never holds a child's text [E33,E32,B24]. */
// fixture-subject: addItem (a journey that seeds a child and a parent board with addItem, then moves their states over the signed link)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { generateBoardKey } from '../../../../../packages/kernel/index.js';
import { openKitBoard } from '../../../tests/fixtures/board.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

const AT = '2026-11-20T08:00:00.000Z';
const SECRET_TITLE = 'Child-only title zq91';
const SECRET_CRITERION = 'Child-only criterion zq92 [test]';
const SECRET_NOTE = 'child-only note zq93';

/** A signer authority that accepts every approval: the signature check is not what this journey proves. */
const authority = {
  async sign(board, _text, { by }) { return { boardId: board, by, on: AT, signature: 'fixture' }; },
  async verify() { return true; },
};

test('cli.journeys-fact-team-children.a-parent-shows-its-childrens-states: clause 1: a parent shows its children\'s states [E33,E32,B24]', async (t) => {
  const folder = privateFixtureFiles('pullboard-children-').root;
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const clock = { now: () => new Date(AT) };
  const parentBoard = openKitBoard(':memory:', clock);
  const childBoard = openKitBoard(':memory:', clock);
  t.after(() => { store.closeBoard(parentBoard); store.closeBoard(childBoard); });
  const parent = { boardId: store.boardId(parentBoard), organization: 'fixture', handle: 'parent' };
  const child = { boardId: store.boardId(childBoard), organization: 'fixture', handle: 'kid' };
  assert.notEqual(parent.boardId, child.boardId);

  const writer = store.register(childBoard, { lane: 'core', path: join(folder, 'builder') });
  /** Move a child item through the real store moves to claimed, or on through submit and an accepted verdict to verified. */
  const freeze = (item) => ({ text: item.item_title, digest: `fixture:${item.item_title}` });
  const head = 'a'.repeat(40);
  function advance(id, state) {
    const builder = store.register(childBoard, { lane: 'core', path: join(folder, `builder-${id}`) });
    store.claim(childBoard, id, { agentId: builder, lane: 'core', leaseMs: 60_000, head, freeze });
    if (state === 'claimed') return;
    submitFixture(childBoard, id, { agentId: builder, commit: head, tree: 't' });
    const reviewer = store.register(childBoard, { lane: 'core', path: join(folder, 'reviewer') });
    store.verify(childBoard, id, { agentId: reviewer, decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'fixture verdict', head, digest: `fixture:${SECRET_TITLE} verified`, policy: 'any' });
  }
  // Three child items on the child board, each carrying text that must never cross.
  const ids = ['open', 'claimed', 'verified'].map((state) => {
    const id = store.addItem(childBoard, { by: 'coordinator', lane: 'core', title: `${SECRET_TITLE} ${state}`, criterion: SECRET_CRITERION });
    store.appendFact(childBoard, id, { agentId: writer, kind: 'note', text: SECRET_NOTE });
    if (state !== 'open') advance(id, state);
    return id;
  });
  const after = ids.map((id) => `kid#${id}`);
  const parentId = store.addItem(parentBoard, { by: 'coordinator', lane: 'core', title: 'Parent of three', after });

  let record = { version: 1, linkId: 'children-link', parent, child, generation: 1, disclosure: 'states', approvals: [], revocation: null };
  record = await store.approveBoardLink(record, parent.boardId, authority, { by: 'parent' });
  record = await store.approveBoardLink(record, child.boardId, authority, { by: 'child' });
  await store.applyBoardLink(parentBoard, record, authority);
  await store.applyBoardLink(childBoard, record, authority);
  const capability = store.createBoardLinkCapability(record, await generateBoardKey());
  // The child board announces the real state of every child item in one signed envelope; the parent receives it through its own capability.
  const rows = ids.map((id) => ({ board: child.boardId, id, state: store.getItem(childBoard, id).item_status }));
  assert.deepEqual(rows.map((row) => row.state), ['open', 'claimed', 'verified']);
  const announcement = { version: 1, linkId: record.linkId, generation: 1, sourceBoardId: child.boardId, destinationBoardId: parent.boardId, position: 1, disclosure: 'states', rows };
  const envelope = await capability.seal('state-1', announcement);
  const receipt = { version: 1, deliveryId: 1, sourceBoardId: child.boardId, destinationBoardId: parent.boardId, linkId: record.linkId, generation: 1,
    correlationId: 'state-1', position: 1, digest: createHash('sha256').update(JSON.stringify(envelope)).digest('hex'), at: AT };
  await store.receiveBoardState(parentBoard, { envelope, receipt }, { authority, capability });
  // The parent lists every child's board, id and state.
  const states = store.foreignDependencyStates(parentBoard, store.getItem(parentBoard, parentId), { readReceivedBoardState: store.readReceivedBoardState });
  assert.deepEqual(states.map((row) => [row.repo, row.id, row.status]), [['kid', ids[0], 'open'], ['kid', ids[1], 'claimed'], ['kid', ids[2], 'verified']]);
  const received = store.readReceivedBoardState(parentBoard, { linkId: record.linkId, generation: 1, sourceBoardId: child.boardId });
  assert.ok(received.rows.every((row) => row.board === child.boardId && Object.keys(row).sort().join() === 'board,id,state'), 'a row names only board, id and state');

  // The parent's replica holds no child title, criterion or note.
  const replica = JSON.stringify(store.exportBoard(parentBoard))
    + JSON.stringify(parentBoard.db.prepare('SELECT * FROM item').all()) + JSON.stringify(parentBoard.db.prepare('SELECT * FROM board_meta').all());
  for (const text of [SECRET_TITLE, SECRET_CRITERION, SECRET_NOTE, 'zq9']) assert.equal(replica.includes(text), false, `${text} stays on the child board`);
});
