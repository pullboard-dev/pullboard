/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  CLI,
  after,
  assert,
  mkdirSync,
  personSession,
  phoneRequest,
  randomBytes,
  receivedRequests,
  relayCall,
  relayFixtureChild,
  runFixtureGit,
  teamBoard,
  test,
} from '../../tests/fixtures/scenarios/team.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureAddArgv } from '../../tests/fixtures/testkit.js';

test('the board knows its people: events name them, approvers decide [E3,E4,E20]', { timeout: 180_000 }, async (t) => { // budget: hang ceiling for two people's real CLI runs and relay calls; not a speed target.
  const box = await teamBoard(t, ['alice']);
  const link = JSON.parse(box.readLink());
  const alice = await personSession(box, 'alice');
  const bob = await personSession(box, 'bob');
  assert.deepEqual((await relayCall(box, alice, 'GET', `/api/v1/boards/${link.board}/approvers`)).document.approvers, ['alice'], 'relay on gave the relay the approvers pullboard.json names');

  // S4c: every move records the person who made it, and the agent if one did.
  assert.equal((await box.cli('add', box.lane, 'An item alice adds')).code, 0);
  const bobRoot = join(box.root, '..', 'bob-clone');
  runFixtureGit(['clone', '-q', box.root, bobRoot], { cwd: box.root, env: box.env });
  runFixtureGit(['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: bobRoot, env: box.env });
  const bobHome = join(box.root, '..', 'bob-home');
  const bobEnv = { ...box.env, HOME: bobHome, PULLBOARD_HOME: join(bobHome, '.pullboard'), PULLBOARD_MACHINE_HOME: join(bobHome, 'machine') };
  box.copyOwnBoardMetadata(bobRoot);
  mkdirSync(join(bobEnv.PULLBOARD_HOME, 'relay-keys'), { recursive: true, mode: 0o700 });
  box.copyOwnKey(bobEnv.PULLBOARD_HOME, link.board);
  box.providerState.signer = 'bob';
  const bobOn = await relayFixtureChild(bobRoot, bobEnv, [CLI, 'relay', 'on', '--url', box.origin, '--json']);
  box.providerState.signer = 'alice';
  assert.equal(bobOn.code, 0, `bob signs in as himself on his own computer: ${bobOn.stderr}`);
  // One coordinator per board [E19]: bob's main checkout takes the coordinator to act, then alice takes it back.
  const bobTakes = await relayFixtureChild(bobRoot, bobEnv, [CLI, 'takeover', '--json']);
  assert.equal(bobTakes.code, 0, `bob's main checkout takes the coordinator: ${JSON.stringify(bobTakes.document?.error ?? null)}`);
  const bobAdd = await relayFixtureChild(bobRoot, bobEnv, [...fixtureAddArgv(CLI), box.lane, 'An item bob adds', '--json']);
  assert.equal(bobAdd.code, 0, `bob adds an item: ${JSON.stringify(bobAdd.document?.error ?? null)}`);
  assert.equal((await box.cli('takeover')).code, 0, 'alice’s main checkout takes the coordinator back');
  const exported = (await box.cli('export')).document.tables;
  const events = exported.event;
  const madeBy = (title) => {
    const id = exported.item.find((item) => item.item_title === title)?.item_id;
    return events.filter((event) => event.event_kind === 'add' && event.item_id === id).map((event) => JSON.parse(event.event_detail).person);
  };
  assert.deepEqual(madeBy('An item alice adds'), ['alice'], 'alice’s move names alice');
  assert.deepEqual(madeBy('An item bob adds'), ['bob'], 'bob’s move names bob');
  assert.ok(events.filter((event) => event.event_kind === 'add').every((event) => event.event_by), 'each move still names the agent or seat that made it');

  // S4b: only an approver answers the person's decisions, and only an approver decides rows.
  const asked = await box.cli('shout', 'person', 'Ship the health endpoint as plain text or JSON?', '--decision');
  assert.equal(asked.code, 0);
  const decision = asked.document.id ?? asked.document.shout_id ?? asked.document.result?.id;
  const fromBob = await phoneRequest(box, bob, { verb: 'answer', item: Number(decision), args: { text: 'JSON' } });
  const fromAlice = await phoneRequest(box, alice, { verb: 'answer', item: Number(decision), args: { text: 'JSON' } });
  const requests = await receivedRequests(box);
  assert.equal(requests[fromBob].status, 'refused', 'bob, a writer but not an approver, cannot answer as the person');
  assert.equal(requests[fromBob].error.code, 'NOT_APPROVER');
  assert.notEqual(requests[fromAlice].status, 'refused', 'alice, an approver, answers as the person');
  const rowFromBob = await phoneRequest(box, bob, { verb: 'spec-approve', args: { ids: 'G1' } });
  assert.equal((await receivedRequests(box))[rowFromBob].error?.code, 'NOT_APPROVER', 'bob cannot approve a row');

  // E4: a change to the list takes effect only once an existing approver makes it.
  assert.equal((await relayCall(box, bob, 'PUT', `/api/v1/boards/${link.board}/approvers`, { approvers: ['bob'] })).document.error?.code, 'NOT_APPROVER', 'bob cannot make himself an approver');
  assert.deepEqual((await relayCall(box, bob, 'GET', `/api/v1/boards/${link.board}/approvers`)).document.approvers, ['alice']);

  // S9: a move no member can open is set aside, and only an approver unlinks the board or replaces its snapshot.
  const bobMachine = JSON.parse(readFileSync(join(bobRoot, '.git', 'pullboard', 'relay.json'), 'utf8')).token;
  const head = await relayCall(box, alice, 'GET', '/api/v2/boards/' + link.board + '/state');
  const after = await relayCall(box, alice, 'GET', `/api/v1/boards/${link.board}/events?after=${head.document.state.sequence}`);
  const next = Math.max(head.document.state.sequence, ...(after.document.events ?? []).map((event) => event.event_id)) + 1;
  const junk = await relayCall(box, bobMachine, 'POST', `/api/v1/boards/${link.board}/moves`, { sequence: next, sealed: randomBytes(64).toString('base64url') });
  assert.equal(junk.status, 200, 'a member’s credential can store bytes no key opens');
  const afterJunk = await box.cli('add', box.lane, 'After the junk');
  assert.equal(afterJunk.code, 0, `replay sets the unopenable move aside and the board moves on: ${afterJunk.stderr ?? ''}${JSON.stringify(afterJunk.document ?? {}).slice(0, 600)}`);
  assert.ok((await box.cli('export')).document.tables.event.some((event) => event.event_kind === 'relay_refused' && JSON.parse(event.event_detail).sequence === next), 'the set-aside move is on the record');
  const deleted = await relayCall(box, bob, 'DELETE', `/api/v1/boards/${link.board}`);
  assert.equal(deleted.document?.error?.code, 'NOT_APPROVER', 'bob cannot unlink the board');
  const replaced = await relayCall(box, bobMachine, 'PUT', `/api/v1/boards/${link.board}/state`, { sequence: next, sealed: randomBytes(64).toString('base64url') });
  assert.equal(replaced.document?.error?.code, 'NOT_APPROVER', 'bob’s computer cannot replace the snapshot');
  assert.equal((await box.cli('status')).code, 0, 'alice’s board still reads');
});

test('the board knows its people: a phone move names the phone’s person, refused or not [E3,E4]', { timeout: 180_000 }, async (t) => { // budget: hang ceiling for real CLI runs and relay calls; not a speed target.
  const box = await teamBoard(t, ['alice']);
  const bob = await personSession(box, 'bob');
  // Bob's phone adds an item; alice's computer carries it out, so the move is sent with alice's credential.
  const title = 'An item from bob’s phone';
  const added = await phoneRequest(box, bob, { verb: 'add', args: { lane: box.lane, title } });
  const asked = await box.cli('shout', 'person', 'Plain text or JSON?', '--decision');
  assert.equal(asked.code, 0);
  const decision = asked.document.id ?? asked.document.shout_id ?? asked.document.result?.id;
  const denied = await phoneRequest(box, bob, { verb: 'answer', item: Number(decision), args: { text: 'JSON' } });
  const requests = await receivedRequests(box);
  assert.equal(requests[added].status, 'done', 'bob’s phone adds the item');
  assert.equal(requests[denied].error?.code, 'NOT_APPROVER', 'bob’s phone cannot answer as the person');
  const tables = (await box.cli('export')).document.tables;
  const id = tables.item.find((item) => item.item_title === title)?.item_id;
  const add = tables.event.find((event) => event.event_kind === 'add' && event.item_id === id);
  const refused = tables.event.find((event) => event.event_kind === 'relay_refused' && JSON.parse(event.event_detail).sequence === requests[denied].sequence);
  assert.ok(add && refused, 'both are on the record');
  assert.equal(JSON.parse(add.event_detail).person, 'bob', 'the add names bob, whose phone asked for it, not alice, whose computer carried it out');
  assert.equal(JSON.parse(refused.event_detail).person, 'bob', 'the refused answer still names bob, who tried it');
});

test('a board that names no approvers takes person moves as before [E4]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for real CLI runs and relay calls; not a speed target.
  const box = await teamBoard(t, null);
  const link = JSON.parse(box.readLink());
  const bob = await personSession(box, 'bob');
  assert.equal((await relayCall(box, bob, 'GET', `/api/v1/boards/${link.board}/approvers`)).document.approvers, null, 'the relay holds no approvers for this board');
  const asked = await box.cli('shout', 'person', 'Plain text or JSON?', '--decision');
  const decision = asked.document.id ?? asked.document.shout_id ?? asked.document.result?.id;
  const fromBob = await phoneRequest(box, bob, { verb: 'answer', item: Number(decision), args: { text: 'JSON' } });
  assert.notEqual((await receivedRequests(box))[fromBob].status, 'refused', 'any writer’s session answers as the person, as today');
});
