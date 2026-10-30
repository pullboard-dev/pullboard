/** @pullboard-test-loads src/board.js src/engine.js src/exchange.js src/person-signing.js relay/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  optionalPasskeyApply,
  optionalPasskeyApplyThroughCli,
  test,
} from './team-scenarios.fixture.js';

test('person-only moves are signed through optional SSH apply [E22,H16]', optionalPasskeyApply);

test('person-only moves are signed: an unlinked CLI applies no passkey decision it cannot verify [E22,H16]', optionalPasskeyApplyThroughCli);
