/** The shared board for the parked-move tests: two computers on one relay board and one move the relay refuses for good (#6693) [B26,H16,H17]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixtureGit } from '../child.js';
import { relayClientFixture } from './client.js';

/** Turn the board's committed relay.outbox setting on, as its coordinator would. */
function enableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: true } }, null, 2) + '\n');
  const cliPath = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore(config): queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
}

/** The texts of the shouts a board export holds. */
export function shoutTexts(exported) {
  return exported.tables.shout.map((row) => row.shout_text);
}

/**
 * Two computers on one accepted relay board, then one fact too big for the relay followed by a small shout, and a sync.
 * The big fact is incompressible, so its sealed move is well over the relay's 100,000-byte request limit.
 */
export async function parkedBoard(t) {
  // A relay that takes only the local API's 100 KB, so one move is too large for it however the hosted limit moves (#6707).
  const box = await relayClientFixture(t, { moveBodyBytes: 100_000 });
  enableOutbox(box);
  await box.link();
  const printed = await box.cliLocal('relay', 'pair');
  const other = await box.otherDeviceJoin(printed.document.code);
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const item = (await box.cliLocal('add', box.lane, 'Carries a long note')).document.item.item_id;
  const before = (await box.cliLocal('status')).document.relay.sequence;
  const big = randomBytes(68_000).toString('base64url');
  const bigNote = await box.cliLocal('fact', String(item), 'note', big);
  assert.equal(bigNote.code, 0, JSON.stringify(bigNote.document?.error ?? bigNote.document).slice(0, 600));
  assert.equal((await box.cliLocal('shout', 'all', 'small after the big move')).code, 0);
  const synced = await box.cliLocal('status');
  assert.equal(synced.code, 0, synced.failure);
  return { box, other, board, before, big, synced };
}

