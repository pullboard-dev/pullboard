/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: the private-board move scenario split from board.test.js for its file budget; its case bytes and deadlines are unchanged. */
import {
  privateBoardMoves,
  relayWorkBudgetMs,
  teamBoard,
  test,
} from '../../../tests/fixtures/scenarios/team.js';
import { seedPrivateBoard } from '../../../tests/fixtures/move.js';

test('cli.journeys-export-team-board-moves.a-private-board-moves-between-the: a private board moves between the private and the team boards [E11,E13,E14,E15]', { timeout: relayWorkBudgetMs(12) }, async (t) => { // budget: linked-device CLI and relay round trips, not a speed target.
  const box = await teamBoard(t, ['alice']);
  const privateFile = await seedPrivateBoard(box);
  await privateBoardMoves(box, privateFile);
});
