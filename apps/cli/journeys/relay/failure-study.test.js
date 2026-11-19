/** The failure study with relay.queueOnFailure on: a down relay and a 503 each record 1 and queue 1 with exit 0, and the queued move is sent in order once the relay answers [H5,H17,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { faultProxy } from '../../../../packages/pages/tests/fixtures/study.js';
import { readRelay } from '../../../../packages/pages/tests/fixtures/study.js';

/** A linked, accepted board whose own relay.outbox is off, so only the machine's relay.queueOnFailure can queue a move. */
async function linked(t) {
  const box = await relayClientFixture(t);
  const file = join(box.root, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), relay: { outbox: false } }, null, 2) + '\n');
  const cliPath = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureSetupGit(['commit', '-q', '-m', 'chore(config): do not queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { relay: { queueOnFailure: true } });
  await box.link();
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselineAccepted, true, 'the relay accepted this board before the failure');
  return box;
}

/** The operations waiting in this linked board's outbox, from the summary the outbox keeps beside the link. */
function queuedOperations(box) {
  const file = join(dirname(box.linkFile), 'relay-outbox.summary.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).moves.map(move => move.operation) : [];
}

/** The titles of the items on the local board, in board order. */
async function localTitles(box) {
  return (await box.cliLocal('export')).document.tables.item.map(row => row.item_title);
}

/** The study's add during one fault, with relay.queueOnFailure on: it exits 0, records the item once and queues one addItem. */
async function addDuring(t, fault) {
  const box = await linked(t);
  if (fault === 'down') await box.stopRelay();
  else (await faultProxy(t, box)).set({ delayMs: 0, status: 503, code: 'RELAY_UNAVAILABLE' });
  const title = 'Study move during ' + fault;
  const move = await box.cliLocal('add', box.lane, title);
  assert.equal(move.code, 0, JSON.stringify(move.document));
  assert.equal((await localTitles(box)).filter(found => found === title).length, 1, 'recorded 1');
  assert.deepEqual(queuedOperations(box), ['addItem'], 'queued 1');
}

test('cli.journeys-relay-failure-study.relay-down-records-and-queues-one: clause 1: with relay.queueOnFailure on, the study relay DOWN case records 1, queues 1 and exits 0 [H5,H17,C7]', { timeout: 300_000 }, async t => {
  await addDuring(t, 'down');
});

test('cli.journeys-relay-failure-study.http-503-records-and-queues-one: clause 1: with relay.queueOnFailure on, the study HTTP 503 case records 1, queues 1 and exits 0 [H5,H17,C7]', { timeout: 300_000 }, async t => {
  await addDuring(t, '5xx');
});

test('cli.journeys-relay-failure-study.queued-move-sent-in-order: clause 2: a move queued while the relay answers 503 is sent before the next move once the relay answers, and the outbox empties [H5,H17,C7]', { timeout: 300_000 }, async t => {
  const box = await linked(t);
  const proxy = await faultProxy(t, box);
  proxy.set({ delayMs: 0, status: 503, code: 'RELAY_UNAVAILABLE' });
  const queued = await box.cliLocal('add', box.lane, 'Study queued first');
  assert.equal(queued.code, 0, JSON.stringify(queued.document));
  assert.deepEqual(queuedOperations(box), ['addItem']);
  proxy.set();
  const next = await box.cliLocal('add', box.lane, 'Study sent second');
  assert.equal(next.code, 0, JSON.stringify(next.document));
  const status = (await box.cliLocal('status')).document.relay;
  assert.equal(status.outbox, undefined, 'the outbox is empty once the relay answers');
  assert.equal(status.outboxRefusals, undefined, 'no queued move was refused: the ordered-acknowledgement and conflict guards held');
  assert.equal(status.behind, 0, 'the relay holds every move');
  const sent = (await readRelay(box)).document.tables.item.map(item => item.item_title).filter(title => title.startsWith('Study '));
  assert.deepEqual(sent, ['Study queued first', 'Study sent second'], 'the relay received the queued move before the later one');
});
