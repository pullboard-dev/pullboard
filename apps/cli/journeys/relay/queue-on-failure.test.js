/** With relay.queueOnFailure on, a real add on a linked board against a down relay or a 503 exits 0, records one item and queues one outbox entry [C7,#10102,#9410]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../tests/fixtures/child.js';
import { dirname } from 'node:path';
import { join } from 'node:path';
import test from 'node:test';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

/** Write the machine settings of this fixture's home: relay.queueOnFailure as given, relay.outbox left off. */
function setQueueOnFailure(box, on) {
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { relay: { queueOnFailure: on } });
}

/** The operations waiting in this linked board's outbox, from the summary the outbox keeps beside the link. */
function queuedOperations(box) {
  const file = join(dirname(box.linkFile), 'relay-outbox.summary.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).moves.map(move => move.operation) : [];
}

/** Commit the board's relay.outbox setting as off, so only the machine's relay.queueOnFailure can queue a move (an absent setting means on). */
function disableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: false } }, null, 2) + '\n');
  const cliPath = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureSetupGit(['commit', '-q', '-m', 'chore(config): do not queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
}

/** A linked, accepted board with relay.queueOnFailure as given. */
async function linked(t, on) {
  const box = await relayClientFixture(t);
  disableOutbox(box);
  setQueueOnFailure(box, on);
  await box.link();
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselineAccepted, true, 'the relay accepted this board before the failure');
  return box;
}

/** Count the items on the local board with the given title. */
async function itemsTitled(box, title) {
  return (await box.cliLocal('export')).document.tables.item.filter(row => row.item_title === title).length;
}

test('cli.journeys-relay-queue-on-failure.with-relay-queueonfailure-on-an-add: clause 1: with relay.queueOnFailure on, an add against a down relay exits 0 and shows recorded 1, queued 1 [C7,#10102,#9410]', async (t) => {
  const box = await linked(t, true);
  await box.stopRelay();
  const added = await box.cliLocal('add', box.lane, 'Added while the relay is down');
  assert.equal(added.code, 0, JSON.stringify(added.document));
  assert.equal(await itemsTitled(box, 'Added while the relay is down'), 1, 'recorded 1');
  assert.deepEqual(queuedOperations(box), ['addItem'], 'queued 1');
});

test('cli.journeys-relay-queue-on-failure.with-relay-queueonfailure-on-an-add-2: clause 1: with relay.queueOnFailure on, an add against a relay answering 503 exits 0 and shows recorded 1, queued 1 [C7,#10102,#9410]', async (t) => {
  const box = await linked(t, true);
  box.refuseMoves(true);
  const added = await box.cliLocal('add', box.lane, 'Added while the relay answers 503');
  assert.equal(added.code, 0, JSON.stringify(added.document));
  assert.equal(await itemsTitled(box, 'Added while the relay answers 503'), 1, 'recorded 1');
  assert.deepEqual(queuedOperations(box), ['addItem'], 'queued 1');
});

test('cli.journeys-relay-queue-on-failure.with-the-setting-off-the-same: clause 2: with the setting off, the same add against a down relay refuses RELAY_UNAVAILABLE and queues nothing [C7,#10102,#9410]', async (t) => {
  const box = await linked(t, false);
  await box.stopRelay();
  const added = await box.cliLocal('add', box.lane, 'Refused while the relay is down');
  assert.notEqual(added.code, 0);
  assert.equal(added.document.error.code, 'RELAY_UNAVAILABLE');
  assert.deepEqual(queuedOperations(box), []);
});
