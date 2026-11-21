/** @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureGit } from '../../../fixtures/child.js';
import { runFixtureSetupGit } from '../../../fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';
import { relayClientFixture } from '../../../fixtures/relay/client.js';

/** Write this fixture's machine setting while leaving relay.outbox disabled. */
function setQueueOnFailure(box, on) {
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { relay: { queueOnFailure: on } });
}

/** Read the queued operations from the linked board's outbox summary. */
function queuedOperations(box) {
  const file = join(dirname(box.linkFile), 'relay-outbox.summary.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).moves.map(move => move.operation) : [];
}

/** Turn off the board setting so the machine setting alone controls queue-on-failure. */
function disableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: false } }, null, 2) + '\n');
  const cliPath = fileURLToPath(new URL('../../../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureSetupGit(['commit', '-q', '-m', 'chore(config): do not queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
}

/** Create an accepted linked board with queue-on-failure set explicitly. */
async function linked(t, on) {
  const box = await relayClientFixture(t);
  disableOutbox(box);
  setQueueOnFailure(box, on);
  await box.link();
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselineAccepted, true, 'the relay accepted this board before the failure');
  return box;
}

/** Count local items with the given title. */
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

test('cli.journeys-relay-queue-on-failure.with-the-setting-off-the-same: clause 1: with the setting off, the same add against a down relay refuses RELAY_UNAVAILABLE and queues nothing [C7,#10102,#9410]', async (t) => {
  const box = await linked(t, false);
  await box.stopRelay();
  const added = await box.cliLocal('add', box.lane, 'Refused while the relay is down');
  assert.notEqual(added.code, 0);
  assert.equal(added.document.error.code, 'RELAY_UNAVAILABLE');
  assert.deepEqual(queuedOperations(box), []);
});

/** @pullboard-world-pin: clause 2 checks the selected cases, retained source cases, golden and exact registry entries. */
test('cli.journeys-relay-queue-on-failure.case-preserves-source-cases: clause 2: selected cases have one registration and the golden and unselected cases remain [C7]', () => {
  const root = resolve(import.meta.dirname, '../../../../../../');
  const moved = readFileSync(resolve(root, 'apps/cli/tests/io/commands/add/relay.test.js'), 'utf8');
  const source = readFileSync(resolve(root, 'apps/cli/journeys/relay/queue-on-failure.test.js'), 'utf8');
  const golden = readFileSync(resolve(root, 'apps/cli/journeys/relay/main-offline.test.js'), 'utf8');
  const registry = JSON.parse(readFileSync(resolve(root, 'apps/cli/tests/fixtures/registry-10548.json'), 'utf8'));
  const selected = [
    'cli.journeys-relay-queue-on-failure.with-relay-queueonfailure-on-an-add',
    'cli.journeys-relay-queue-on-failure.with-relay-queueonfailure-on-an-add-2',
    'cli.journeys-relay-queue-on-failure.with-the-setting-off-the-same',
  ];
  for (const id of selected) {
    assert.equal(registry[id]?.inputs?.join(','), 'apps/cli/tests/io/commands/add/relay.test.js', `${id} has one focused registry input`);
    assert.equal(moved.split(`test('${id}:`).length - 1, 1, `${id} is moved once`);
    assert.equal(source.split(`test('${id}:`).length - 1, 0, `${id} is absent from its source`);
  }
  assert.equal(source.match(/test\('/gu)?.length ?? 0, 0, 'the source has no remaining cases because all three were selected');
  assert.ok(golden.includes('test('), 'the main-offline end-to-end golden remains');
});
