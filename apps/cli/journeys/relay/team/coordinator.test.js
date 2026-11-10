/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  assert,
  hostname,
  relayClientFixture,
  relayFixtureChild,
  relayWorkBudgetMs,
  test,
} from '../../../tests/fixtures/scenarios/team.js';
import { resolve } from 'node:path';

/**
 * Add an item as a coordinator and read the refusal the relay reports for it. A linked board moves locally first and
 * settles later [H21], so the add returns at once and the sync-time refusal appears in the device's status.
 * `add` runs the add (any session); `device` reads the status.
 */
async function refusedCoordinatorAdd(device, lane, title, add = () => device.cli('add', lane, title)) {
  const since = new Date().toISOString();
  const added = await add();
  assert.equal(added.code, 0, 'a linked board applies the move locally at once, then settles it with the relay');
  const status = await device.cli('status');
  assert.equal(status.code, 0, status.failure);
  const refused = (status.document.relay.outboxRefusals ?? []).filter(entry => entry.queuedAt >= since).at(-1);
  assert.equal(refused?.code, 'COORDINATOR_HELD', JSON.stringify(status.document.relay.outboxRefusals ?? null));
  return refused;
}

test('one coordinator per board across machines [E19]', { timeout: relayWorkBudgetMs(12) }, async t => { // budget: hang ceiling for two linked devices' real CLI and relay round trips; not a speed target.
  const box = await relayClientFixture(t);
  await box.link();
  const pairing = await box.cli('relay', 'pair');
  const other = await box.otherDeviceJoin(pairing.document.code);
  /** A refusal's code and message as the CLI reports them. */
  const refusal = result => ({ code: result.document?.error?.code, message: String(result.document?.error?.message ?? '') });

  // The first device to act as coordinator holds it; the board keeps working there as it does today.
  assert.equal((await box.cli('add', box.lane, 'Planned on the first machine')).code, 0, 'the first machine coordinates');
  assert.equal((await box.cli('add', box.lane, 'Still planned on the first machine')).code, 0, 'the holder keeps coordinating');

  // On one machine, the main checkout is held by one agent session at a time; takeover passes it between sessions.
  /** Run the first machine's real CLI from a named agent session. */
  const inSession = (session, ...args) => relayFixtureChild(box.root, { ...box.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session },
    [resolve(import.meta.dirname, '../../../pullboard.js'), ...args, '--json']);
  assert.equal((await inSession('first-session', 'add', box.lane, 'Planned in the first session')).code, 0, 'one agent session coordinates');
  assert.equal(refusal(await inSession('second-session', 'add', box.lane, 'Planned in a second session')).code, 'NOT_YOUR_CHECKOUT',
    'a second session acting as coordinator in the same main checkout is refused');
  assert.equal((await inSession('second-session', 'takeover')).code, 0, 'takeover passes the main checkout to the second session');
  assert.equal((await inSession('second-session', 'add', box.lane, 'Planned in the second session after takeover')).code, 0, 'the new session coordinates');
  assert.equal(refusal(await inSession('first-session', 'add', box.lane, 'Planned again in the first session')).code, 'NOT_YOUR_CHECKOUT',
    'the earlier session is refused after the takeover');

  // A second machine's main checkout acting as coordinator is refused, by name.
  const second = await refusedCoordinatorAdd(other, box.lane, 'Planned on the second machine');
  const firstName = `computer ${JSON.parse(box.readLink()).machine.slice(-8)}`;
  const secondName = `computer ${other.machine.slice(-8)}`;
  assert.notEqual(firstName, secondName, 'the two linked computers have different names');
  assert.ok(second.message.includes(firstName), `the refusal names the holding computer: ${second.message}`);
  assert.doesNotMatch(second.message, new RegExp(hostname(), 'u'), 'the name carries no host name');
  assert.match(second.message, /pullboard takeover/u, 'the refusal names the takeover');

  // Takeover passes the coordinator to the second machine, and the first is then refused by name.
  const taken = await other.cli('takeover');
  assert.equal(taken.code, 0, `takeover passes the coordinator: ${JSON.stringify(taken.document)}`);
  assert.equal(taken.document.coordinator, secondName, 'takeover reports the new holder');
  assert.equal(taken.document.previous, firstName, 'takeover reports the holder it replaced');
  assert.equal((await other.cli('add', box.lane, 'Planned on the second machine after takeover')).code, 0, 'the new holder coordinates');
  const first = await refusedCoordinatorAdd(box, box.lane, 'Planned again on the first machine');
  assert.ok(first.message.includes(secondName), `the refusal names the new holder: ${first.message}`);

  // Both replicas agree on the items each holder made, and on no others.
  for (const device of [box, other]) {
    const titles = (await device.cli('list')).document.items.map(item => item.item_title);
    assert.deepEqual(titles.filter(title => title.startsWith('Planned') || title.startsWith('Still')).sort(),
      ['Planned in the first session', 'Planned in the second session after takeover', 'Planned on the first machine',
        'Planned on the second machine after takeover', 'Still planned on the first machine']);
  }
});

test('an agent session on a computer that does not hold the coordinator takes it over [E19]', { timeout: relayWorkBudgetMs(12) }, async t => { // budget: hang ceiling for two linked devices' real CLI and relay round trips; not a speed target.
  const box = await relayClientFixture(t);
  await box.link();
  const pairing = await box.cli('relay', 'pair');
  const other = await box.otherDeviceJoin(pairing.document.code);
  /** Run the second computer's real CLI from a named agent session. */
  const inSession = (...args) => relayFixtureChild(other.root, { ...other.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'second-computer-session' },
    [resolve(import.meta.dirname, '../../../pullboard.js'), ...args, '--json']);
  assert.equal((await box.cli('add', box.lane, 'Planned on the holding computer')).code, 0, 'the first computer holds the coordinator');
  const held = await refusedCoordinatorAdd(other, box.lane, 'Planned before the takeover', () => inSession('add', box.lane, 'Planned before the takeover'));
  assert.match(held.message, /pullboard takeover/u, 'the refusal names the takeover');
  const taken = await inSession('takeover');
  assert.equal(taken.code, 0, `the takeover the refusal names succeeds from the agent session: ${JSON.stringify(taken.document)}`);
  assert.equal(taken.document.coordinator, `computer ${other.machine.slice(-8)}`, 'the second computer now holds the coordinator');
  assert.equal((await inSession('add', box.lane, 'Planned after the takeover')).code, 0, 'the new holder coordinates');
  await refusedCoordinatorAdd(box, box.lane, 'Planned again on the first computer');
});
