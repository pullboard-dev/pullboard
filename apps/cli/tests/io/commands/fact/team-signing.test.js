/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
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
} from '../../../fixtures/scenarios/team.js';

test('cli.journeys-fact-team-signing.person-only-moves-are-signed: clause 1: person-only moves are signed [E22,B26,H16]', { timeout: relayWorkBudgetMs(60) }, async (t) => { // budget: hang ceiling for real CLI runs and relay calls; not a speed target.
  await personSigningCase(t, { CLI, TRUSTED_CLI, helpers, passkeyRequest, holdsNoPersonCredential, relayCall, receivedRequests });
});
