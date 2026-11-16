/** A seat whose item waits in the gate may claim, edit and add beside it only when itemsInGate is sealed into the move [C7,#8420]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../../../../index.js';
import { claim } from '../../../../index.js';
import { register } from '../../../../index.js';
import { recordSubmitHandoff } from '../../../../../jobs/index.js';
import { requireAgentGrant } from '../../../../../state/index.js';
import { ENGINE_VERSION } from '../../../../../state/index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';

const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });
const MINUTE = 60_000;

/** One seat holding a first item whose gate is queued, and a second item it wants to change. */
function fixture(t) {
  const board = fixtureBoard(t);
  register(board, { lane: 'coordinator', path: '/coordinator' });
  const seat = register(board, { lane: 'core', path: '/seat', route: 'strong' });
  const first = addItem(board, { by: 'coordinator', lane: 'core', title: 'First in the gate', route: 'strong' });
  const second = addItem(board, { by: 'coordinator', lane: 'core', title: 'Second to build', route: 'strong' });
  claim(board, first, { agentId: seat, lane: 'core', leaseMs: 60 * MINUTE, freeze: FREEZE });
  recordSubmitHandoff(board.db, first, { version: 1, id: 'job-1', agentId: seat, commit: 'c'.repeat(40), state: 'queued' });
  const edit = (extra = {}) => ({ operation: 'editItem', args: [second, { agentId: seat, title: 'Second, edited' }], engine: ENGINE_VERSION, actor: seat, ...extra });
  return { board, seat, edit };
}

test('clause 1: a seat whose item is in the gate can change another item when itemsInGate is sealed on [C7]', t => {
  const { board, edit } = fixture(t);
  assert.doesNotThrow(() => requireAgentGrant(board, edit({ itemsInGate: 3 })));
});

test('clause 2: the same change is refused AGENT_GRANT_ITEM when the setting is off [C7]', t => {
  const { board, edit } = fixture(t);
  assert.throws(() => requireAgentGrant(board, edit()), { code: 'AGENT_GRANT_ITEM' });
});
