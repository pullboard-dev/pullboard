/** Real Git, ordered board work and deterministic dispatch boundaries [N2,V1,B3,A6,V2]. */
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { waitForState } from '../../tests/fixtures/check-baseline.js';
import { main } from '../../tests/fixtures/native.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { AUTOMATIC_DISPATCH_ENGINE } from '../../../../packages/state/light.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { bindLocalSession } from '../../../../packages/seats/index.js';
import { recordItemSession } from '../../../../packages/items/index.js';
import { dispatchHealth } from '../../../../packages/sentinels/index.js';


/** Claim an item as the actor seat and start its submit handoff, as `submit --no-next` leaves it. */
function submitting(box, title) {
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const id = box.add(title);
  box.claim(id, seat);
  const head = box.git(seat.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${head}^{tree}`);
  const item = store.getItem(box.board, id);
  const job = store.writeBoardCommand(box.board, 'queueSubmitHandoff', [id, { agentId: seat.id,
    job: randomUUID(), main: head, commit: head, tree, executionCommit: head, executionTree: tree,
    digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 }], seat.id).job;
  store.startSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id });
  return id;
}

test('cli.journeys-next-take.a-free-seat-is-handed-one: a free seat is handed one eligible item without screening [N2,V1,B3]', async t => {
  const box = await fixture(t, { route: 'light' });
  const future = box.add('Older item in a future release', { route: 'light' });
  const wrongLane = box.add('Wrong lane', { lane: 'docs', route: 'light' });
  const strong = box.add('Wrong route', { route: 'strong' });
  const held = box.add('Held by the coordinator', { route: 'light' });
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'A real fixture hold' });
  const ready = box.add('Current release item', { route: 'light' });
  addMilestone(box.board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Current', items: [wrongLane, strong, held, ready] });
  addMilestone(box.board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Future', items: [future] });
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, ready);
  assert.equal(store.getItem(box.board, ready).item_owner, box.seats.actor.id);
  const claims = () => store.listItems(box.board).filter(item => item.item_status === 'claimed' && item.item_owner === box.seats.actor.id);
  await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(claims().length, 1, 'a holding seat never acquires another item');
  store.release(box.board, ready, box.seats.actor.id, 'Return the private fixture claim for the next selection', 'OTHER');
  const review = box.add('Review before another build', { route: 'light' });
  box.submit(review);
  const offered = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, review);
  assert.equal(store.getItem(box.board, review).item_review_by, box.seats.actor.id);
  assert.equal(claims().length, 0, 'review reservation and build claim are mutually exclusive');
});

test('cli.journeys-next-take.next-take-gives-a-seat-with: next --take gives a seat with a running handoff a different item and no --wait [C7,#2882]', async t => {
  const box = await fixture(t);
  const held = submitting(box, 'Submitted and gating');
  const other = box.add('Another open item', { brief: 'Files: web/other.js\nTest: an unrelated file.' });
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);

  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, other);
  assert.notEqual(taken.document.item.item_id, held, 'the item whose handoff is running is not handed back');
  assert.equal(store.getItem(box.board, other).item_owner, box.seats.actor.id);
});

test('cli.journeys-next-take.the-commit-msg-hook-accepts-the: the commit-msg hook accepts the submitted item trailer while its handoff runs [C7,#2882]', async t => {
  const box = await fixture(t);
  const id = submitting(box, 'Submitted and gating');
  const cwd = box.seats.actor.path;
  mkdirSync(join(cwd, 'web'), { recursive: true });
  writeFileSync(join(cwd, 'web/follow-up.js'), 'export const x = 1;\n');
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', 'fix(web): follow up [G1]', '-m', `Pullboard-Item: #${id}`);

  assert.match(box.git(cwd, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${id}`, 'u'));
});

/** Keep an existing claim's lease and event history intact when ordinary next resumes it. */
test('cli.journeys-next-take.default-next-resumes-its-held-claim: default next resumes its held claim without renewing or refreezing it [C7,N2,B5,V2]', async t => {
  const box = await fixture(t);
  const id = box.add('Claim already held by this seat');
  box.claim(id, box.seats.actor);
  const before = store.events(box.board, { itemId: id });
  const lease = store.getItem(box.board, id).item_lease_until;

  const resumed = await cli(box, box.seats.actor.path, ['next']);

  assert.equal(resumed.code, 0, resumed.out + resumed.err);
  assert.equal(resumed.document.item.item_id, id);
  assert.equal(resumed.document.held, true);
  assert.equal(store.getItem(box.board, id).item_lease_until, lease, 'resuming work does not extend its lease');
  assert.deepEqual(store.events(box.board, { itemId: id }), before, 'resuming work adds no renew or refreeze event');
});

/** A current spec correction must not force an existing holder through a fresh claim freeze. */
test('cli.journeys-next-take.default-next-resumes-a-held-claim: default next resumes a held claim after its cited row leaves the live spec [C7,N2,V2]', async t => {
  const box = await fixture(t);
  const id = box.add('Claim with a retired cited row');
  box.claim(id, box.seats.actor);
  writeFileSync(join(box.root, 'SPEC.md'), '# Dispatch fixture\n## G\n');

  const resumed = await cli(box, box.seats.actor.path, ['next']);

  assert.equal(resumed.code, 0, resumed.out + resumed.err);
  assert.equal(resumed.document.item.item_id, id);
  assert.equal(resumed.document.held, true);
  assert.equal(store.getItem(box.board, id).item_status, 'claimed');
});

for (const reason of ['BLOCKED', 'ROUTED_ELSEWHERE', 'INELIGIBLE']) {
  test(`clause 1 and clause 2: after a ${reason} release next --take refuses a sibling seat and status shows the item as needing re-scope [C7]`, async t => {
    const box = await fixture(t);
    const id = box.add('Item that needs re-scope');
    box.claim(id, box.seats.actor);
    store.release(box.board, id, box.seats.actor.id, 'The fixture seat cannot build this item as scoped', reason);
    box.advance(31 * 60_000);
    const sibling = await cli(box, box.seats.builder.path, ['next', '--take']);
    assert.equal(sibling.code, 1, sibling.out + sibling.err);
    assert.equal(typeof sibling.document?.error?.code, 'string', 'native no-work refusal is retained');
    assert.notEqual(sibling.document?.item?.item_id, id, `a second seat of the same lane and route is not offered the ${reason} item`);
    const status = await cli(box, box.root, ['status']);
    assert.equal(status.document.needsRescope[0].id, id, 'status shows the item as needing re-scope with its release reasons');
  });
}

test('cli.journeys-next-take.a-coordinator-edit-never-leaves-an: a coordinator edit never leaves an item unclaimable [V2,N2]', async t => {
  const box = await fixture(t);
  const id = box.add('An open corrected bar');
  const edited = await cli(box, box.root, ['edit', String(id), '--criterion', 'The corrected open criterion', '--reason', 'Correct the fixture bar']);
  assert.equal(edited.code, 0, edited.out + edited.err);
  const corrected = store.getItem(box.board, id);
  assert.ok(corrected.item_frozen_digest, 'an unclaimed correction freezes its bar in the same move');
  assert.equal(JSON.parse(corrected.item_frozen).criterion, 'The corrected open criterion');
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  const held = store.getItem(box.board, id);
  const changed = await cli(box, box.root, ['edit', String(id), '--criterion', 'The corrected held criterion',
    '--check', 'true && true', '--reason', 'Correct the held fixture bar']);
  assert.equal(changed.code, 0, changed.out + changed.err);
  const current = store.getItem(box.board, id);
  assert.equal(current.item_owner, held.item_owner);
  assert.equal(current.item_lease_until, held.item_lease_until);
  assert.equal(JSON.parse(current.item_frozen).criterion, 'The corrected held criterion');
  assert.equal(JSON.parse(current.item_frozen).check, 'true && true');
  assert.deepEqual(store.pendingRefreeze(box.board, id), []);
  const notices = store.inbox(box.board, held.item_owner).filter(shout => shout.shout_text.includes(`#${id}`));
  assert.ok(notices.some(shout => /correct/i.test(shout.shout_text) && !/pending|refreeze/i.test(shout.shout_text)));
  const renewed = await cli(box, box.seats.actor.path, ['claim', String(id)]);
  assert.equal(renewed.code, 0, renewed.out + renewed.err);
  const noCheck = box.add('A corrected bar without an item-specific shell', { check: '' });
  const noCheckEdit = await cli(box, box.root, ['edit', String(noCheck), '--criterion', 'The corrected checkless criterion', '--reason', 'Correct the checkless fixture']);
  assert.equal(noCheckEdit.code, 0, noCheckEdit.out + noCheckEdit.err);
  const checkless = store.getItem(box.board, noCheck);
  assert.ok(checkless.item_frozen_digest);
  assert.equal(JSON.parse(checkless.item_frozen).criterion, 'The corrected checkless criterion');
  assert.equal(Object.hasOwn(JSON.parse(checkless.item_frozen), 'check'), false, 'the established frozen format omits an empty check');
});

test('cli.journeys-next-take.an-explicit-heartbeat-and-the-installed: an explicit heartbeat and the installed native stop hook record presence and never claim [N2,I6,C7,#3001]', async t => {
  const box = await fixture(t);
  const id = box.add('A heartbeat leaves work for next --take');
  const beat = await cli(box, box.seats.actor.path, ['heartbeat']);
  assert.equal(beat.code, 0, beat.out + beat.err);
  assert.equal(store.getItem(box.board, id).item_owner, null);
  const hook = await cli(box, box.seats.actor.path, ['hook', 'Stop']);
  assert.equal(hook.code, 0, hook.out + hook.err);
  assert.equal(store.getItem(box.board, id).item_owner, null, hook.out + hook.err);
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(store.getItem(box.board, id).item_owner, box.seats.actor.id);
});

test('cli.journeys-next-take.an-atomic-correction-replays-identically-and: an atomic correction replays identically and a bad frozen payload changes no item [V2,H16]', async t => {
  const box = await fixture(t);
  const id = box.add('A deterministic corrected bar');
  box.claim(id, box.seats.actor);
  const replica = fixtureBoard(t, { clock: box.clock });
  importBoard(replica, exportBoard(box.board));
  const change = { agentId: 'coordinator', criterion: 'A sealed correction', reason: 'Correct the actual bar', correction: true,
    freeze: item => {
      const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    } };
  const move = prepareEngineMove(box.board, 'editItem', [id, change], { actor: 'coordinator' });
  assert.equal(Object.hasOwn(move.args[1], 'freeze'), false, 'no callback travels to another replica');
  const options = { sequence: 1, at: box.clock.now().toISOString(), kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } };
  const result = applyRelayMove(box.board, move, options);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(applyRelayMove(replica, move, options), result);
  assert.deepEqual(exportBoard(replica), exportBoard(box.board), 'rows, notices, events and receipts match exactly');
  const beforeItem = store.getItem(box.board, id);
  const refusedFreeze = prepareEngineMove(replica, 'editItem', [id, { ...change,
    freeze: () => { throw new Refused('SPEC_DRAFT', 'the corrected row must be approved'); } }], { actor: 'coordinator' });
  const failedFreeze = applyRelayMove(replica, refusedFreeze, { ...options, sequence: 2 });
  assert.equal(failedFreeze.error?.code, 'SPEC_DRAFT');
  assert.deepEqual(store.getItem(replica, id), store.getItem(box.board, id));
  const invalid = structuredClone(move);
  invalid.id += '-invalid';
  invalid.args[1].frozen.digest = '0'.repeat(64);
  const refused = applyRelayMove(box.board, invalid, { ...options, sequence: 2 });
  assert.equal(refused.error?.code, 'RELAY_MOVE');
  assert.deepEqual(store.getItem(box.board, id), beforeItem);
  assert.deepEqual(store.events(box.board), store.events(replica), 'failed correction creates no edit or notice');
  const old = structuredClone(move);
  old.id += '-old'; old.engine = AUTOMATIC_DISPATCH_ENGINE - 1;
  const unchanged = exportBoard(replica);
  assert.throws(() => applyRelayMove(replica, old, { ...options, sequence: 3 }), error => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(replica), unchanged, 'an old envelope cannot disguise the new semantics');
});

test('cli.journeys-next-take.health-reads-each-seat-session-instead: health reads each seat session instead of offering its own material for review [V1,B3,A6]', async t => {
  const box = await fixture(t);
  const id = box.add('Material from an earlier seat in the same session');
  box.submit(id);
  const info = repoInfo(box.seats.actor.path);
  const digest = 'a'.repeat(64);
  await bindLocalSession(info, { agent: box.seats.actor.id, digest });
  recordItemSession(info, id, 'submit', digest);
  const observed = dispatchHealth(box.board, box.config);
  assert.ok(observed.dispatch.some(pair => pair.item === id), 'an outside seat remains eligible');
  assert.ok(observed.dispatch.every(pair => pair.seat !== box.seats.actor.id), 'the old material ledger excludes the same session');
  box.scan();
  box.advance(300000);
  heartbeatSeat(box.board, box.seats.actor.id);
  const later = dispatchHealth(box.board, box.config);
  assert.ok(later.findings.every(finding => !finding.subject.includes(box.seats.actor.id)), 'no five-minute warning names an ineligible session');
});

test('cli.journeys-next-take.health-observes-each-of-two-free: health observes each of two free seats beside the item next selects for it [N2,A6]', async t => {
  const box = await fixture(t);
  const first = box.add('First ready item');
  const second = box.add('Second ready item');
  const observed = dispatchHealth(box.board, box.config);
  // Health reports the item next actually selects for each free seat (#1160, 7bb430cfcb), so both seats may name the top item.
  assert.ok(observed.dispatch.every(pair => [first, second].includes(pair.item)));
  assert.equal(new Set(observed.dispatch.map(pair => pair.seat)).size, 2, 'each free seat has its own observation');
  box.scan(); box.advance(300000); box.scan();
  const messages = store.allShouts(box.board).filter(shout => shout.shout_to === 'coordinator' && shout.shout_text.startsWith('Stuck:') && shout.shout_text.includes('UNPAIRED_WORK'));
  assert.equal(messages.length, 2, 'each free seat has one loud warning');
});

test('cli.journeys-next-take.take-build-one-step: clause 1: next --take --build claims the one open build item, with a submitted review waiting, in a single call that reserves no review [C7,#11942]', async t => {
  const box = await fixture(t, { route: 'light' });
  const review = box.add('Submitted work waiting for review', { route: 'light' });
  box.submit(review);
  const open = box.add('The one open build item', { route: 'light' });
  const taken = await cli(box, box.seats.actor.path, ['next', '--take', '--build']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, open);
  assert.equal(store.getItem(box.board, open).item_owner, box.seats.actor.id);
  assert.notEqual(store.getItem(box.board, review).item_review_by, box.seats.actor.id, 'the waiting review is never reserved');
});

test('cli.journeys-next-take.take-build-wait: clause 2: next --take --build --wait 1 blocks while no build item is open, then returns the claim once one is filed [C7,#11942]', async t => {
  const box = await fixture(t, { route: 'light' });
  const waiting = cli(box, box.seats.actor.path, ['next', '--take', '--build', '--wait', '1']);
  await waitForState(() => box.board.db.prepare("SELECT 1 FROM event WHERE event_by = ? AND event_kind = 'next-idle'").get(box.seats.actor.id), 'the waiting take records its idle observation before work is filed');
  const filed = box.add('Filed while the take waits', { route: 'light' });
  const taken = await waiting;
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, filed);
  assert.equal(store.getItem(box.board, filed).item_owner, box.seats.actor.id);
});
