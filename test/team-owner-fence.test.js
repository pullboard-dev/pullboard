/** @pullboard-test-loads src/board.js src/engine.js src/exchange.js src/person-signing.js apps/relay/src/shell/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  helpers,
  landingQueueCase,
  test,
} from './team-scenarios.fixture.js';

test('clause 1: a suspended landing owner is fenced before the queued adopter runs [Q1,Q3]', { timeout: 120_000 }, // budget: real 30s authority expiry, independent guardian watchdog, cleanup and adoption; no speed target.
  async t => landingQueueCase(t, helpers, { suspendParent: true }));
