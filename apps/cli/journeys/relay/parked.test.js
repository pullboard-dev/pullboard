/** A move the relay refuses for good is parked, later moves flow, and pullboard relay recover resolves it in place (#6693) [B26,H16,H17]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  describeMove,
  refusalLine,
} from '../../../../packages/outbox/index.js';
import { briefLines } from '../../../../packages/link/src/io/relay/output.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

/** The command every refusal and status line names. */
const RECOVER = 'pullboard relay recover';

/** Turn the board's committed relay.outbox setting on, as its coordinator would. */
function enableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: true } }, null, 2) + '\n');
  const cliPath = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore(config): queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
}

/** The texts of the shouts a board export holds. */
function shoutTexts(exported) {
  return exported.tables.shout.map((row) => row.shout_text);
}

/**
 * Two computers on one accepted relay board, then one move too big for the relay followed by a small one, and a sync.
 * The big shout is incompressible, so its sealed move is well over the relay's 100,000-byte request limit.
 */
async function parkedBoard(t) {
  const box = await relayClientFixture(t);
  enableOutbox(box);
  await box.link();
  const printed = await box.cliLocal('relay', 'pair');
  const other = await box.otherDeviceJoin(printed.document.code);
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const before = (await box.cliLocal('status')).document.relay.sequence;
  const big = randomBytes(68_000).toString('base64url');
  assert.equal((await box.cliLocal('shout', 'all', big)).code, 0);
  assert.equal((await box.cliLocal('shout', 'all', 'small after the big move')).code, 0);
  const synced = await box.cliLocal('status');
  assert.equal(synced.code, 0, synced.failure);
  return { box, other, board, before, big, synced };
}

test('clause 1: a move the relay permanently refuses is parked and later moves are sent and acknowledged [B26,H16,H17]', { timeout: 280_000 }, async (t) => {
  const { box, other, before, synced } = await parkedBoard(t);
  const outbox = synced.document.relay.outbox;
  assert.equal(outbox.length, 1, 'only the refused move stays in the outbox');
  assert.equal(outbox[0].operation, 'shout');
  assert.ok(outbox[0].parked?.code, 'the outbox entry says the relay refused it for good');
  assert.ok(synced.document.relay.sequence > before, 'the small move behind the refused one was sent and acknowledged');
  const there = await other.cli('export');
  const texts = shoutTexts(there.document);
  assert.ok(texts.includes('small after the big move'), 'the second computer reads the move that flowed');
  assert.ok(!texts.some((text) => text.length > 50_000), 'the refused move did not reach the relay');
  const again = await box.cliLocal('status');
  assert.equal(again.document.relay.outbox.length, 1, 'a later sync leaves the parked move parked, not retried in a loop');
});

test('clause 2: pullboard relay recover publishes a checkpoint under the same board id and a second computer reads every move [B26,H16,H17]', { timeout: 280_000 }, async (t) => {
  const { box, other, board, big } = await parkedBoard(t);
  const recovered = await box.cliLocal('relay', 'recover');
  assert.equal(recovered.code, 0, recovered.failure);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(link.board, board, 'the board id is unchanged: no rejoin');
  const there = await other.cli('export');
  assert.equal(there.code, 0, there.failure);
  const texts = shoutTexts(there.document);
  assert.ok(texts.includes(big), 'the parked move\'s effect reaches the second computer');
  assert.ok(texts.includes('small after the big move'), 'no history is lost');
  const here = shoutTexts((await box.cliLocal('export')).document);
  assert.deepEqual(here, texts, 'both computers hold the same shouts in the same order');
});

test('clause 3: the refusal and relay status name pullboard relay recover, and status reads healthy once the queue drains [B26,H16,H17]', { timeout: 280_000 }, async (t) => {
  const { box, synced } = await parkedBoard(t);
  const parked = synced.document.relay.outbox[0].parked;
  assert.equal(parked.next, RECOVER, 'the parked move names the one command');
  assert.notEqual(synced.document.relay.health.status, 'healthy', 'a board with a parked move does not read healthy');
  assert.ok(synced.document.relay.health.text.includes(RECOVER), 'the health line names the command');
  const lines = briefLines({ linked: true, sequence: 1, behind: 1, outbox: synced.document.relay.outbox }, { describeMove, refusalLine });
  assert.ok(lines.some((line) => line.includes(RECOVER) && /parked/u.test(line)), 'status output names the command beside the parked move');
  assert.equal((await box.cliLocal('relay', 'recover')).code, 0);
  const drained = await box.cliLocal('status');
  assert.equal(drained.document.relay.outbox, undefined, 'the queue drained');
  assert.equal(drained.document.relay.health.status, 'healthy', 'status reads healthy');
});
