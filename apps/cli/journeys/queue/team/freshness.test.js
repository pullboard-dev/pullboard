/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  helpers,
  landingQueueCase,
  test,
} from '../../../tests/fixtures/scenarios/team.js';

test('cli.journeys-queue-team-freshness.a-queued-landing-rechecks-freshness-after: a queued landing rechecks freshness after its holder moves main [E8,Q1,Q2]', { timeout: 120_000 }, // budget: real private Git/CLI and deterministic gate barrier; no speed target.
  async t => landingQueueCase(t, helpers, { staleAfterFirst: true }));
