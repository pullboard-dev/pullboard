/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: the private-board move scenario split from board.test.js for its file budget; its case bytes and deadlines are unchanged. */
import {
  assert,
  privateBoardMoves,
  privateBoardPath,
  relayWorkBudgetMs,
  teamBoard,
  test,
} from '../../../tests/fixtures/scenarios/team.js';
import { settleRelayCalls } from '../../../tests/fixtures/move.js';

test('a private board moves between the private and the team boards [E11,E13,E14,E15]', { timeout: relayWorkBudgetMs(12) }, async (t) => { // budget: linked-device CLI and relay round trips, not a speed target.
  const box = await teamBoard(t, ['alice']);
  const shared = await box.cli('add', box.lane, 'repo item');
  assert.equal(shared.code, 0, 'ordinary add stays on the linked repo board');
  const repoBoardId = box.before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value;
  await settleRelayCalls(box); // the shared add's background sender may still be talking to the relay
  const local = await box.cli('add', box.lane, 'private item', '--private');
  assert.equal(local.code, 0, `private add stays available beside a linked team board: ${JSON.stringify(local.document?.error ?? null)}`);
  await privateBoardMoves(box, privateBoardPath(repoBoardId, box.env.PULLBOARD_HOME));
});
