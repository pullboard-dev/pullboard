/** @pullboard-test-loads src/board.js src/engine.js src/exchange.js src/person-signing.js relay/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  helpers,
  landingQueueCase,
  test,
} from './team-scenarios.fixture.js';

test('a queued landing rechecks freshness after its holder moves main [E8,Q1,Q2]', { timeout: 120_000 }, // budget: real private Git/CLI and deterministic gate barrier; no speed target.
  async t => landingQueueCase(t, helpers, { staleAfterFirst: true }));
