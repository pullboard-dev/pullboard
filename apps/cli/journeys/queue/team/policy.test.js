/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js packages/store/src/io/exchange.js packages/person/src/io/signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  helpers,
  landingQueueCase,
  test,
} from '../../../tests/fixtures/scenarios/team.js';

test('a trunk lands one batch at a time [B3,R3,Q1,Q2,E8]', { timeout: 120_000 }, // budget: hang ceiling for real private Git, CLI checks, both gate barriers and cleanup; no speed target.
  async t => landingQueueCase(t, helpers));

test('a queued landing uses admitted policy and repairs before pinning it [Q1,B3]', { timeout: 120_000 }, // budget: two real CLI landings and bounded recorded-tip repair, not a speed threshold.
  async t => landingQueueCase(t, helpers, { policyAfterFirst: true }));
