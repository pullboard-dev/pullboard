/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  firstPinNeedsBuiltInRelay,
  firstUnpairedAuthorityInsertion,
  relayWorkBudgetMs,
  test,
} from '../../../fixtures/scenarios/team.js';

test('cli.journeys-fact-team-pin.person-only-moves-are-signed-before: person-only moves are signed before the first authority pin [E22,B26,H16]', firstUnpairedAuthorityInsertion);

test('cli.journeys-fact-team-pin.person-only-moves-are-signed-only: person-only moves are signed only from the built-in relay over TLS [E22,B26,H16]', { timeout: relayWorkBudgetMs(8) }, firstPinNeedsBuiltInRelay); // budget: hang ceiling for one link and two refused CLI runs; not a speed target.
