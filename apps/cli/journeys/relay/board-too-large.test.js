/** relay on refuses a board too large for the relay, naming its size and the limit, before changing anything (#7777) [B26,H16,H17]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

test('clause 1: relay on for a board whose presentation exceeds the relay limit refuses with its size and the limit and leaves pullboard.json unchanged [B26,H16,H17]', { timeout: 120_000 }, async (t) => {
  const box = await relayClientFixture(t);
  assert.equal((await box.cliLocal('status')).code, 0, 'the board exists before relay on');
  const config = join(box.root, 'pullboard.json');
  const before = existsSync(config) ? readFileSync(config, 'utf8') : null;
  // A tiny limit stands in for the relay's, so the test needs no giant board.
  box.env.PULLBOARD_RELAY_PRESENTATION_LIMIT = '1000';
  const refused = await box.cliLocal('relay', 'on', '--url', box.origin);
  assert.notEqual(refused.code, 0, 'relay on refuses');
  const said = JSON.stringify([refused.failure, refused.document]);
  assert.match(said, /RELAY_BOARD_TOO_LARGE/u, 'the refusal names its rule');
  assert.match(said, /this board is \d+(\.\d+)? MB, over the 0\.0 MB the relay takes/u, 'it names the board size and the limit');
  assert.equal(existsSync(config) ? readFileSync(config, 'utf8') : null, before, 'pullboard.json is unchanged');
  assert.equal(existsSync(box.linkFile), false, 'no link was written');
});
