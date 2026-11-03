/** @pullboard-test-loads src/board.js src/engine.js src/exchange.js src/person-signing.js apps/relay/src/shell/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  CLI,
  TRUSTED_CLI,
  helpers,
  holdsNoPersonCredential,
  passkeyRequest,
  personSigningCase,
  receivedRequests,
  relayCall,
  relayWorkBudgetMs,
  test,
} from './team-scenarios.fixture.js';

test('person-only moves are signed [E22,B26,H16]', { timeout: relayWorkBudgetMs(60) }, async (t) => { // budget: hang ceiling for real CLI runs and relay calls; not a speed target.
  await personSigningCase(t, { CLI, TRUSTED_CLI, helpers, passkeyRequest, holdsNoPersonCredential, relayCall, receivedRequests });
});
