/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js packages/state/src/io/machine.js */
/** A frozen check run records the rename it followed as a fact and keeps the item's digest [C7,#2969]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { openKitBoard } from '../../../../../board/tests/fixtures/board.js';
import { rigorFixtureBoard } from '../../../fixtures/testkit.js';
import { runFrozenProof } from '../../../../heavy.js';

/** A not-executed check result carrying the renames checkAtCommit followed. */
const checked = renames => async () => ({ state: 'pass', green: true, executed: false, checked: true, report: '', renames });

test('gate.io-check-rename-record.a-followed-rename-becomes-a-fact: clause 1: a followed rename becomes a fact on the item naming the old and new path [C7]', async () => {
  const box = rigorFixtureBoard(store, openKitBoard);
  try {
    const id = box.submit('Rename follower');
    const item = store.getItem(box.board, id);
    const seen = [];
    await runFrozenProof(box.root, item, {}, {
      checkAtCommit: checked([{ from: 'test/old.test.js', to: 'packages/x/tests/new.test.js' }]),
      appendFact: (itemId, fact) => { seen.push(itemId); return store.appendFact(box.board, itemId, { agentId: item.item_owner, ...fact }); },
    });
    assert.deepEqual(seen, [id]);
    const text = JSON.stringify(store.itemThread(box.board, id).filter(entry => entry.type === 'fact'));
    assert.match(text, /test\/old\.test\.js/);
    assert.match(text, /packages\/x\/tests\/new\.test\.js/);
  } finally { box.close(); }
});

test('gate.io-check-rename-record.the-frozen-check-digest-is-unchanged: clause 2: the frozen check digest is unchanged after that run [C7]', async () => {
  const box = rigorFixtureBoard(store, openKitBoard);
  try {
    const id = box.submit('Rename digest');
    const item = store.getItem(box.board, id);
    await runFrozenProof(box.root, item, {}, {
      checkAtCommit: checked([{ from: 'a.test.js', to: 'b.test.js' }]),
      appendFact: (itemId, fact) => store.appendFact(box.board, itemId, { agentId: item.item_owner, ...fact }),
    });
    assert.equal(store.getItem(box.board, id).item_frozen_digest, item.item_frozen_digest);
  } finally { box.close(); }
});
