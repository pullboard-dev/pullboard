/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  optionalPasskeyApply,
  optionalPasskeyApplyThroughCli,
  test,
} from '../../../tests/fixtures/scenarios/team.js';

test('cli.journeys-fact-team-apply.person-only-moves-are-signed-through: person-only moves are signed through optional SSH apply [E22,H16]', optionalPasskeyApply);

test('cli.journeys-fact-team-apply.person-only-moves-are-signed-an: person-only moves are signed: an unlinked CLI applies no passkey decision it cannot verify [E22,H16]', optionalPasskeyApplyThroughCli);
