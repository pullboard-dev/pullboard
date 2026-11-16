import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';
/** Real Git, ordered board work and deterministic dispatch boundaries [N2,V1,B3,A6,V2]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { main } from '../../tests/fixtures/native.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { AUTOMATIC_DISPATCH_ENGINE } from '../../../../packages/state/light.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { bindLocalSession } from '../../../../packages/seats/index.js';
import { recordItemSession } from '../../../../packages/items/index.js';
import { dispatchHealth } from '../../../../packages/sentinels/index.js';
import { healthReport } from '../../../../packages/health/index.js';
import { deliverHealthNotices } from '../../../../packages/store/index.js';
import { warnMainMoved } from '../../../../packages/merge/index.js';


test('a free seat is handed one eligible item without screening [N2,V1,B3]', async t => {
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

test('next --take gives a seat with a running handoff a different item and no --wait [C7,#2882]', async t => {
  const box = await fixture(t);
  const held = submitting(box, 'Submitted and gating');
  const other = box.add('Another open item', { brief: 'Files: web/other.js\nTest: an unrelated file.' });
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);

  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, other);
  assert.notEqual(taken.document.item.item_id, held, 'the item whose handoff is running is not handed back');
  assert.equal(store.getItem(box.board, other).item_owner, box.seats.actor.id);
});

test('the commit-msg hook accepts the submitted item trailer while its handoff runs [C7,#2882]', async t => {
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
test('default next resumes its held claim without renewing or refreezing it [C7,N2,B5,V2]', async t => {
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
test('default next resumes a held claim after its cited row leaves the live spec [C7,N2,V2]', async t => {
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

test('a coordinator edit never leaves an item unclaimable [V2,N2]', async t => {
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


test('an explicit heartbeat and the installed native stop hook record presence and never claim [N2,I6,C7,#3001]', async t => {
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

test('an atomic correction replays identically and a bad frozen payload changes no item [V2,H16]', async t => {
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


test('health reads each seat session instead of offering its own material for review [V1,B3,A6]', async t => {
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


test('health observes each of two free seats beside the item next selects for it [N2,A6]', async t => {
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

test('an expired claim is reclaimed through board eligibility on the next take [N2,B3]', async t => {
  const box = await fixture(t);
  const id = box.add('Expired work remains dispatchable');
  box.claim(id, box.seats.actor);
  box.advance(3600001);
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  const current = store.getItem(box.board, id);
  assert.equal(current.item_owner, box.seats.actor.id);
  assert.ok(current.item_lease_until > box.clock.now().toISOString(), 'a raw stale claim cannot strand a free seat');
});


test('a capped dispatch warning is delivered once by the next ordinary sentinel pass [A6,N2]', () => {
  const warning = { key: 'UNPAIRED_WORK:web-1:1', cause: 'UNPAIRED_WORK', item: 1, subject: 'web-1 beside #1',
    title: 'unpaired work', since: '2026-10-25T10:00:00Z', why: 'the seat is free', next: 'run pullboard next --take', owner: 'coordinator' };
  const other = Array.from({ length: 10 }, (_, index) => ({ ...warning, key: `OTHER:${index}`, cause: 'OTHER' }));
  const sent = [];
  const delivery = { engine: AUTOMATIC_DISPATCH_ENGINE, coordinator: 'coordinator', targets: () => ['coordinator'],
    shout: (to, text) => sent.push({ to, text }), log: () => {} };
  const pending = deliverHealthNotices({ ...delivery, resolved: [], added: [...other, warning] });
  assert.deepEqual(pending, [warning], 'the cap cannot silently drop the five-minute warning');
  assert.equal(sent.filter(message => message.text.includes('[UNPAIRED_WORK]')).length, 0);
  assert.deepEqual(deliverHealthNotices({ ...delivery, resolved: [], added: [], pending }), []);
  assert.equal(sent.filter(message => message.text.includes('[UNPAIRED_WORK]')).length, 1);
});


test('a legacy pending correction is adopted atomically when its holder renews [V2,H16]', async t => {
  const box = await fixture(t);
  const id = box.add('A legacy correction must not strand current claims');
  box.claim(id, box.seats.actor);
  // This deliberately replays the older untyped edit protocol; new coordinator CLI edits carry their bar.
  const move = prepareEngineMove(box.board, 'editItem', [id, { agentId: 'coordinator',
    criterion: 'The already approved legacy correction', reason: 'Correct the legacy fixture' }], { actor: 'coordinator' });
  const result = applyRelayMove(box.board, move, { sequence: 1, at: box.clock.now().toISOString(), kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(store.pendingRefreeze(box.board, id), ['criterion'], 'the old receipt retains its historical meaning');
  const renewed = await cli(box, box.seats.actor.path, ['claim', String(id)]);
  assert.equal(renewed.code, 0, renewed.out + renewed.err);
  const current = store.getItem(box.board, id);
  assert.equal(current.item_owner, box.seats.actor.id);
  assert.equal(JSON.parse(current.item_frozen).criterion, 'The already approved legacy correction');
  assert.deepEqual(store.pendingRefreeze(box.board, id), []);
});


test('a held review still returns a newly conflicting submission before offering more work [V1,R3]', async t => {
  const box = await fixture(t);
  const id = box.add('A review that will conflict with trunk');
  box.claim(id);
  mkdirSync(join(box.seats.builder.path, 'web'), { recursive: true });
  writeFileSync(join(box.seats.builder.path, 'web/dispatch.js'), 'export const side = "builder";\n');
  box.git(box.seats.builder.path, 'add', 'web/dispatch.js');
  box.git(box.seats.builder.path, 'commit', '-q', '-m', 'feat(web): build dispatch fixture [G1]');
  const head = box.git(box.seats.builder.path, 'rev-parse', 'HEAD');
  submitFixture(box.board, id, { agentId: box.seats.builder.id, commit: head,
    tree: box.git(box.root, 'rev-parse', `${head}^{tree}`) });
  const first = await cli(box, box.seats.outside.path, ['next', '--take']);
  assert.equal(first.code, 0, first.out + first.err);
  assert.equal(store.getItem(box.board, id).item_review_by, box.seats.outside.id);
  mkdirSync(join(box.root, 'web'), { recursive: true });
  writeFileSync(join(box.root, 'web/dispatch.js'), 'export const side = "main";\n');
  box.git(box.root, 'add', 'web/dispatch.js');
  box.git(box.root, 'commit', '-q', '-m', 'feat(web): move trunk independently [G1]');
  const second = await cli(box, box.seats.outside.path, ['next', '--take']);
  assert.equal(second.code, 1, second.out + second.err);
  assert.equal(JSON.parse(second.out).error.code, 'NOTHING_FREE',
    'after the conflict return this review-only seat has no eligible work');
  const returned = store.getItem(box.board, id);
  assert.equal(returned.item_status, 'open', 'Git conflict preflight also applies to an already reserved review');
  assert.equal(returned.item_review_by, null);
  assert.deepEqual(store.verdictsFor(box.board, id), [], 'a conflict return is not a fabricated verification verdict');
});


test('automatic review reservation retains coordinator-only policy when a higher lane item is ineligible [N2,V1,B3]', async t => {
  const box = await fixture(t, { policy: 'coordinator' });
  const blocked = box.add('Higher-ranked lane review');
  box.submit(blocked);
  const allowed = box.add('Eligible coordinator-lane review', { lane: 'coordinator' });
  box.claim(allowed, { id: 'coordinator', lane: 'coordinator' });
  const head = box.git(box.root, 'rev-parse', 'HEAD');
  submitFixture(box.board, allowed, { agentId: 'coordinator', commit: head,
    tree: box.git(box.root, 'rev-parse', `${head}^{tree}`) });
  const reviewer = box.seats.outside;
  const offered = store.nextFor(box.board, { agentId: reviewer.id, lane: reviewer.lane,
    verify: true, policy: 'coordinator' });
  assert.equal(offered.item.item_id, allowed, 'selection skips the higher-ranked lane review under the actual policy');
  const taken = await cli(box, reviewer.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.review, true);
  assert.equal(taken.document.item.item_id, allowed, 'the native reserve chooses the same eligible item');
  assert.equal(store.getItem(box.board, allowed).item_review_by, reviewer.id);
  assert.equal(store.getItem(box.board, blocked).item_review_by, null, 'the ineligible item is never reserved');
  assert.equal(store.getItem(box.board, blocked).item_status, 'submitted');
  assert.deepEqual(store.verdictsFor(box.board, allowed), [], 'assignment fabricates no verdict');
  assert.equal(store.listItems(box.board).some(item => item.item_status === 'claimed'
    && item.item_owner === reviewer.id), false, 'an eligible review is not replaced with a build');
});

/** Give each candidate a disjoint file so the queue's normal collision guard stays active. */
function lightBrief(file) {
  return `Files: web/${file}.js\nTest: the selected route owns its ready work.`;
}

/** An empty native next records the existing next-idle event used by the activity window. */
async function lightSeatRunsIdleNext(box) {
  const before = store.events(box.board).length;
  await main(['next'], { cwd: box.seats.actor.path, clock: box.clock,
    stdout: { isTTY: false, write: () => {} }, stderr: { write: () => {} } });
  assert.ok(store.events(box.board).slice(before).some(event => event.event_by === box.seats.actor.id
    && event.event_kind === 'next-idle'), 'the light seat recorded an empty-next observation');
}

test('an empty next observation counts as light-seat activity, but a manual claim does not [N2,B13]', async t => {
  const box = await fixture(t, { route: 'light' });
  await lightSeatRunsIdleNext(box);
  const strong = box.add('Strong work', { route: 'strong', brief: lightBrief('idle-strong') });
  const light = box.add('Prioritized light work', { route: 'light', brief: lightBrief('idle-light') });
  assert.equal(store.nextFor(box.board, { agentId: box.seats.builder.id, lane: 'web', priority: [light] }).item.item_id, strong,
    'the existing next-idle event activates the reservation');

  const manualBox = await fixture(t, { route: 'light' });
  const manual = manualBox.add('Manual light claim', { route: 'light', brief: lightBrief('manual-claim') });
  manualBox.claim(manual, manualBox.seats.actor);
  const manualStrong = manualBox.add('Strong work', { route: 'strong', brief: lightBrief('manual-strong') });
  const manualLight = manualBox.add('Prioritized light work', { route: 'light', brief: lightBrief('manual-light') });
  assert.equal(store.nextFor(manualBox.board, { agentId: manualBox.seats.builder.id, lane: 'web', priority: [manualLight] }).item.item_id, manualLight,
    'a manual claim without autoNextSnapshot is not mistaken for a next invocation');
  assert.equal(store.getItem(manualBox.board, manualStrong).item_status, 'open');
});

test('clause 2: list, status data and the health report name each excluded item with its reason and age [C7]', async t => {
  const box = await fixture(t);
  const id = box.add('Item excluded for re-scope');
  box.claim(id, box.seats.actor);
  store.release(box.board, id, box.seats.actor.id, 'The fixture seat cannot build this item as scoped', undefined, 'ROUTED_ELSEWHERE');
  box.advance(7 * 60_000);
  const listed = await cli(box, box.seats.builder.path, ['list']);
  assert.equal(listed.code, 0, listed.out + listed.err);
  const row = listed.document.needsRescope.find(entry => entry.id === id);
  assert.match(row.reasons[0], /ROUTED_ELSEWHERE.*released 7 min ago/u);
  const excluded = store.allItemsNeedingRescope(box.board);
  assert.equal(excluded[0].id, id);
  assert.match(excluded[0].reasons[0], /ROUTED_ELSEWHERE.*released 7 min ago/u);
  const finding = healthReport({ db: box.board.db, root: box.root, config: box.config, now: box.clock.now(), dispatchHealth }).stuck.find(row => row.cause === 'NEEDS_RESCOPE' && row.item === id);
  assert.match(finding.why, /released 7 min ago/u);
});

/** Capture a claimed item's merge warning while its seat and immutable queue may name different sources. */
async function mainMoveWarningFixture(t, { queued = false } = {}) {
  const box = await fixture(t, { files: { 'web/shared.txt': 'base\n' } });
  const id = box.add('Warn from the item source, not the seat checkout');
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(id)]);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const folder = claimed.document.itemFolder;
  assert.ok(folder, 'the live claim has its own item worktree');
  writeFileSync(join(folder, 'web/shared.txt'), 'item source\n');
  box.git(folder, 'add', 'web/shared.txt');
  box.git(folder, 'commit', '-q', '-m', 'feat(web): item folder source [G1]');
  const itemHead = box.git(folder, 'rev-parse', 'HEAD');
  if (queued) {
    const item = store.getItem(box.board, id);
    const tree = box.git(folder, 'rev-parse', 'HEAD^{tree}');
    store.queueSubmitHandoff(box.board, id, { agentId: box.seats.actor.id, job: randomUUID(),
      main: box.git(box.root, 'rev-parse', 'HEAD'), commit: itemHead, tree,
      executionCommit: itemHead, executionTree: tree, digest: item.item_frozen_digest,
      companionDigest: null, leaseMs: 3_600_000 });
    writeFileSync(join(folder, 'web/later.txt'), 'newer worktree head\n');
    box.git(folder, 'add', 'web/later.txt');
    box.git(folder, 'commit', '-q', '-m', 'feat(web): newer item folder source [G1]');
  }
  writeFileSync(join(box.seats.actor.path, 'web/seat-source.txt'), 'another item source\n');
  box.git(box.seats.actor.path, 'add', 'web/seat-source.txt');
  box.git(box.seats.actor.path, 'commit', '-q', '-m', 'feat(web): another seat source [G1]');
  const seatHead = box.git(box.seats.actor.path, 'rev-parse', 'HEAD');
  assert.notEqual(itemHead, seatHead, 'the seat checkout no longer names this item source');
  writeFileSync(join(box.root, 'web/shared.txt'), 'main source\n');
  box.git(box.root, 'add', 'web/shared.txt');
  box.git(box.root, 'commit', '-q', '-m', 'chore(web): conflicting main source [G1]');
  const trunk = box.git(box.root, 'rev-parse', 'HEAD');
  const shouts = [], lines = [];
  const warnings = await warnMainMoved({ root: box.root, board: box.board, trunk,
    write: async (operation, args) => shouts.push({ operation, args }), say: line => lines.push(line) },
  { listAgents: store.listAgents, listItems: store.listItems, submitHandoff: store.submitHandoff });
  return { box, id, folder, itemHead, seatHead, trunk, warnings, shouts, lines };
}

test("submit merges main from the item's own folder when the seat checkout has another source [B5,V4]", async t => {
  const result = await mainMoveWarningFixture(t);
  assert.deepEqual(result.warnings.find(warning => warning.item === result.id),
    { item: result.id, head: result.itemHead, trunk: result.trunk, files: ['web/shared.txt'] });
  assert.equal(result.shouts.length, 1);
  assert.equal(result.shouts[0].operation, 'shout');
  assert.match(result.shouts[0].args[0].text, new RegExp(result.itemHead.slice(0, 12)));
  assert.doesNotMatch(result.shouts[0].args[0].text, new RegExp(result.seatHead.slice(0, 12)));

  const { box, id, folder, itemHead, trunk } = result;
  const item = store.getItem(box.board, id);
  submitFixture(box.board, id, { agentId: box.seats.actor.id, commit: itemHead,
    tree: box.git(folder, 'rev-parse', 'HEAD^{tree}') });
  store.verify(box.board, id, { agentId: box.seats.outside.id, decision: 'REJECT', reason: 'TEST_FAILURE',
    clause: item.item_criterion, note: 'Synthetic return retains the submitted source for repair.',
    head: itemHead, digest: item.item_frozen_digest, policy: 'any' });
  box.claim(id, box.seats.actor);
  box.git(box.root, 'worktree', 'move', folder, folder + '-retained');
  const shouts = [];
  const warnings = await warnMainMoved({ root: box.root, board: box.board, trunk,
    write: async (operation, args) => shouts.push({ operation, args }), say: () => {} },
  { listAgents: store.listAgents, listItems: store.listItems, submitHandoff: store.submitHandoff });
  assert.deepEqual(warnings.find(warning => warning.item === id),
    { item: id, head: itemHead, trunk, files: ['web/shared.txt'] }, 'a returned item keeps its submitted head without its original folder');
  assert.equal(shouts.length, 1);
  assert.match(shouts[0].args[0].text, new RegExp(itemHead.slice(0, 12)));
  assert.doesNotMatch(shouts[0].args[0].text, new RegExp(result.seatHead.slice(0, 12)));
});

test('a queued merge-repair shout keeps the captured submit source ahead of a newer item-folder head [B5,V4]', async t => {
  const result = await mainMoveWarningFixture(t, { queued: true });
  assert.deepEqual(result.warnings.find(warning => warning.item === result.id),
    { item: result.id, head: result.itemHead, trunk: result.trunk, files: ['web/shared.txt'] });
  assert.match(result.shouts[0].args[0].text, new RegExp(result.itemHead.slice(0, 12)));
  assert.doesNotMatch(result.shouts[0].args[0].text, new RegExp(result.seatHead.slice(0, 12)));
});

test('clause 1: next after a release from an item folder that cleanup removed runs from the seat checkout and hands out work [B5,N2]', async t => {
  const box = await fixture(t, { files: { 'web/shared.txt': 'base\n' } });
  const id = box.add('Released from its own item folder');
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(id), '--no-next']);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const folder = claimed.document.itemFolder;
  assert.ok(folder && existsSync(folder), 'the live claim has its own item folder');
  const released = await cli(box, folder, ['release', String(id), '--reason', 'OTHER', '--note', 'Release from the item folder, then chain next', '--no-next']);
  assert.equal(released.code, 0, released.out + released.err);
  assert.equal(existsSync(folder), false, 'cleanup removed the clean item folder the release ran in');
  const other = box.add('Work next hands out after the release');
  // The agent's shell still stands in the removed folder, so its next starts with that path as its working directory.
  const chained = await cli(box, folder, ['next', '--take']);
  assert.doesNotMatch(chained.out + chained.err, /uv_cwd|ENOENT/u);
  assert.equal(chained.code, 0, chained.out + chained.err);
  assert.ok([id, other].includes(chained.document.item.item_id), 'next hands out build work');
  assert.equal(store.getItem(box.board, chained.document.item.item_id).item_owner, box.seats.actor.id);
});
