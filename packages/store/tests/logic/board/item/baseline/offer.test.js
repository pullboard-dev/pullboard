/** @pullboard-test-loads packages/items/src/io/offer.js */
/** Durable offers disclose content only to their recipient; private receipts carry references [B2,H3,H16]. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from "../../../../../index.js";
import * as items from "../../../../../../items/index.js";
import { openCellBoard as openBoard } from "../../../../fixtures/cell.js";

test('an accepted offer makes at most one child and a receipt carries no text [B2,H3,H16]', async t => {
  assert.equal(typeof items.acceptItemOffer, 'function', 'the shared item-offer contract must exist');
  const api = items;
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-item-offer-'));
  const boards = [];
  t.after(() => { for (const entry of boards) store.closeBoard(entry.board); rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['source', 'destination']) {
    const root = join(directory, name);
    mkdirSync(root);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    execFileSync('git', ['init', '-q', '-b', 'main', root], { env });
    const file = join(root, '.git', 'board.sqlite'), board = openBoard(file);
    store.board_ensureCoordinator(board, root);
    boards.push({ board, file, id: store.boardId(board) });
  }
  const [source, destination] = boards;
  const parent = store.addItem(source.board, { by: 'coordinator', lane: 'web', title: 'Private parent' });
  const offer = { version: 1, offerId: 'offer-1', sourceBoardId: source.id, parentItem: parent,
    destinationBoardId: destination.id, proposedContent: { lane: 'web', title: 'Disclosed child', criterion: 'Disclosed bar' },
    disposition: 'pending', childRef: null, reason: null };
  const resolveBoardRef = id => boards.some(entry => entry.id === id) ? { boardId: id } : null;
  // The consumer's explicit authority port binds intent; this fixture never claims native person presence.
  let allowed = true;
  const ports = { atomic: store.atomic, itemById: store.itemById, readBoardId: store.boardId, boardId: destination.id, resolveBoardRef, authorize: () => allowed,
    createChild: content => store.addItem(destination.board, { by: 'coordinator', ...content }) };
  assert.throws(() => api.acceptItemOffer(source.board, offer, ports), { code: 'OFFER_AUTHORITY' });
  const accepted = api.acceptItemOffer(destination.board, offer, ports);
  assert.equal(accepted.childRef.boardId, destination.id);
  assert.equal(store.listItems(destination.board, { all: true }).length, 1);
  assert.equal(store.getItem(destination.board, accepted.childRef.item).item_parent_id, null, 'foreign parent id never becomes a local parent');
  store.closeBoard(destination.board);
  destination.board = openBoard(destination.file);
  assert.deepEqual(api.acceptItemOffer(destination.board, offer, ports), accepted, 'retry after reopen returns the saved child');
  assert.equal(store.listItems(destination.board, { all: true }).length, 1);
  const reordered = Object.fromEntries(Object.entries(offer).reverse());
  assert.deepEqual(api.acceptItemOffer(destination.board, reordered, ports), accepted, 'wire key order does not change retry identity');
  assert.throws(() => api.acceptItemOffer(destination.board, { ...offer, proposedContent: { ...offer.proposedContent, title: 'Changed' } }, ports), { code: 'OFFER_CONFLICT' });
  assert.throws(() => api.acceptItemOffer(destination.board, { ...offer, offerId: 'bad', title: 'Hidden' }, ports), { code: 'ITEM_OFFER' });
  const count = store.listItems(destination.board, { all: true }).length;
  assert.throws(() => api.acceptItemOffer(destination.board, { ...offer, offerId: 'rollback' }, { ...ports, createChild: content => { ports.createChild(content); return -1; } }), { code: 'ITEM_OFFER' });
  assert.equal(store.listItems(destination.board, { all: true }).length, count, 'invalid child creation rolls back the real insert and retry state');
  allowed = false;
  assert.throws(() => api.acceptItemOffer(destination.board, { ...offer, offerId: 'denied' }, ports), { code: 'OFFER_AUTHORITY' });
  allowed = true;
  const declined = api.declineItemOffer(destination.board, { ...offer, offerId: 'offer-2' }, 'No capacity', ports);
  const announcement = api.itemOfferAnnouncement(declined);
  assert.equal(Object.hasOwn(announcement, 'proposedContent'), false);
  assert.equal(JSON.stringify(announcement).includes('Disclosed'), false);
  api.recordItemOfferResult(source.board, announcement, { ...ports, boardId: source.id });
  assert.equal(api.readItemOffer(source.board, source.id, 'offer-2').reason, 'No capacity');
  assert.equal(api.readItemOffer(destination.board, source.id, 'offer-2').reason, 'No capacity');
  assert.throws(() => api.recordItemOfferResult(source.board, { ...announcement, reason: 'Changed' }, { ...ports, boardId: source.id }), { code: 'OFFER_CONFLICT' });
  const key = 'fixture-only-authority-key';
  const sign = text => createHmac('sha256', key).update(text).digest('hex');
  const fields = { version: 1, sourceBoardId: destination.id, item: accepted.childRef.item,
    commit: 'a'.repeat(40), verifier: 'review-1', verdict: 'verdict-1' };
  const receipt = api.minimalItemReceipt(fields, { sign });
  assert.equal(api.verifyItemReceipt(receipt, { resolveBoardRef, verify: (text, signature) => sign(text) === signature }, fields), true);
  assert.deepEqual(Object.keys(receipt).sort(), [...Object.keys(fields), 'integrity'].sort());
  for (const extra of ['title', 'criterion', 'note']) {
    assert.throws(() => api.minimalItemReceipt({ ...fields, [extra]: 'Private' }, { sign }), { code: 'ITEM_RECEIPT' });
    assert.throws(() => api.verifyItemReceipt({ ...receipt, [extra]: 'Private' }, { resolveBoardRef, verify: () => true }, fields), { code: 'ITEM_RECEIPT' });
  }
  for (const change of [{ sourceBoardId: source.id }, { item: 999 }, { commit: 'b'.repeat(40) }, { verifier: 'other' }, { verdict: 'other' }]) {
    assert.throws(() => api.verifyItemReceipt(receipt, { resolveBoardRef, verify: () => true }, { ...fields, ...change }), { code: 'ITEM_RECEIPT' });
  }
  for (const integrity of [{ ...receipt.integrity, digest: '0'.repeat(64) }, { ...receipt.integrity, signature: 'tampered' }]) {
    assert.throws(() => api.verifyItemReceipt({ ...receipt, integrity }, { resolveBoardRef, verify: (text, signature) => sign(text) === signature }, fields), { code: 'ITEM_RECEIPT' });
  }
  assert.throws(() => api.verifyItemReceipt(receipt, { resolveBoardRef, verify: () => false }, fields), { code: 'ITEM_RECEIPT' });
});
