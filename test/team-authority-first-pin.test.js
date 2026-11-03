/** @pullboard-test-loads src/board.js src/engine.js src/exchange.js src/person-signing.js apps/relay/src/shell/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  firstPinNeedsBuiltInRelay,
  firstUnpairedAuthorityInsertion,
  relayWorkBudgetMs,
  test,
} from './team-scenarios.fixture.js';

test('person-only moves are signed before the first authority pin [E22,B26,H16]', firstUnpairedAuthorityInsertion);

test('person-only moves are signed only from the built-in relay over TLS [E22,B26,H16]', { timeout: relayWorkBudgetMs(8) }, firstPinNeedsBuiltInRelay); // budget: hang ceiling for one link and two refused CLI runs; not a speed target.
