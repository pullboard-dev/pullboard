/** A sentinel notice queued while the relay is down reaches it and never jams the moves after it (#7774) [C7,B26,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

/** Turn the board's committed relay.outbox setting on, as its coordinator would. */
function enableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: true } }, null, 2) + '\n');
  // The board's own commit hook runs pullboard, so this private PATH gets the CLI under test.
  const cliPath = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore(config): queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
}

/** The shout senders and texts a board export holds, in board order. */
function shouts(exported) {
  return exported.tables.shout.map((row) => `${row.shout_from}: ${row.shout_text}`);
}

/** Run one fixture command, naming the step when the fixture itself throws. */
async function step(name, run) {
  try { return await run(); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

test('clause 1: a queued sentinel shout reaches the relay and the moves after it are acknowledged [C7,B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  enableOutbox(box);
  await box.link();
  const other = await step('pair', async () => box.otherDeviceJoin((await box.cliLocal('relay', 'pair')).document.code));

  await box.stopRelay();
  // A reservation held by a gone submitter is reclaimed at once, and a reclaim is what the wait audit shouts about.
  const queue = join(box.env.PULLBOARD_MACHINE_HOME, 'handoff-queue');
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(queue, '000000000002-job-b.reserved'), JSON.stringify({ pid: 4194301, started: 'x' }));
  const audited = await step('waits record', () => box.cliLocal('waits', 'record'));
  assert.equal(audited.code, 0, audited.failure);
  const after = await step('shout after', () => box.cliLocal('shout', 'all', 'made after the sentinel notice'));
  assert.equal(after.code, 0, after.failure);
  const waiting = await step('status down', () => box.cliLocal('status'));
  assert.deepEqual(waiting.document.relay.outbox.map((move) => move.operation), ['shout', 'shout'], 'the sentinel notice and the shout after it wait');

  await box.restartRelay();
  const drained = await step('status up', () => box.cliLocal('status'));
  assert.equal(drained.code, 0, drained.failure);
  assert.equal(drained.document.relay.outbox, undefined, 'the outbox drains past the sentinel notice');
  assert.deepEqual(drained.document.relay.outboxRefusals ?? [], [], 'no queued move is refused');

  const there = (await step('export there', () => other.cli('export'))).document;
  const here = (await step('export here', () => box.cliLocal('export'))).document;
  const sent = shouts(there).filter((line) => line.startsWith('sentinel: waits:') || line.endsWith('made after the sentinel notice'));
  assert.equal(sent.length, 2, `the other computer reads the sentinel notice and the move after it: ${JSON.stringify(shouts(there))}`);
  assert.ok(sent[0].startsWith('sentinel: '), 'the sentinel notice keeps its system actor');
  assert.deepEqual(shouts(here), shouts(there), 'both computers hold the same shouts in the same order');
});
