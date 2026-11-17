/** Reclaim, sentinel warnings, held reviews and submit merge fixtures around next --take [N2,V1,B3,A6,V2]. */
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { AUTOMATIC_DISPATCH_ENGINE } from '../../../../packages/state/light.js';
import { dispatchHealth } from '../../../../packages/sentinels/index.js';
import { healthReport } from '../../../../packages/health/index.js';
import { deliverHealthNotices } from '../../../../packages/store/index.js';
import { warnMainMoved } from '../../../../packages/merge/index.js';


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

/** Assert a delivered shout's fields: addressed to the item, naming the item's head and not the seat checkout's. */
function assertShoutNamesHead(shout, id, itemHead, seatHead) {
  assert.equal(shout.from, 'coordinator');
  assert.equal(shout.to, `item:${id}`);
  assert.equal(shout.item, id);
  assert.ok(shout.text.includes(itemHead.slice(0, 12)), 'the shout names the item head');
  assert.ok(!shout.text.includes(seatHead.slice(0, 12)), 'the shout never names the seat checkout head');
}

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

test('cli.journeys-next-take-part2.an-expired-claim-is-reclaimed-through: an expired claim is reclaimed through board eligibility on the next take [N2,B3]', async t => {
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

test('cli.journeys-next-take-part2.a-capped-dispatch-warning-is-delivered: a capped dispatch warning is delivered once by the next ordinary sentinel pass [A6,N2]', () => {
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

test('cli.journeys-next-take-part2.a-legacy-pending-correction-is-adopted: a legacy pending correction is adopted atomically when its holder renews [V2,H16]', async t => {
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

test('cli.journeys-next-take-part2.a-held-review-still-returns-a: a held review still returns a newly conflicting submission before offering more work [V1,R3]', async t => {
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

test('cli.journeys-next-take-part2.automatic-review-reservation-retains-coordinator-only: automatic review reservation retains coordinator-only policy when a higher lane item is ineligible [N2,V1,B3]', async t => {
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

test('cli.journeys-next-take-part2.an-empty-next-observation-counts-as: an empty next observation counts as light-seat activity, but a manual claim does not [N2,B13]', async t => {
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

test('cli.journeys-next-take-part2.list-status-data-and-the-health: clause 2: list, status data and the health report name each excluded item with its reason and age [C7]', async t => {
  const box = await fixture(t);
  const id = box.add('Item excluded for re-scope');
  box.claim(id, box.seats.actor);
  store.release(box.board, id, box.seats.actor.id, 'The fixture seat cannot build this item as scoped', undefined, 'ROUTED_ELSEWHERE');
  box.advance(7 * 60_000);
  const listed = await cli(box, box.seats.builder.path, ['list']);
  assert.equal(listed.code, 0, listed.out + listed.err);
  const row = listed.document.needsRescope.find(entry => entry.id === id);
  assert.equal(row.reasons.length, 1);
  assert.ok(row.reasons[0].includes(': ROUTED_ELSEWHERE'), 'the reason carries the release reason code');
  assert.equal(Math.round((box.clock.now() - Date.parse(row.since)) / 60_000), 7, 'the list JSON dates the release 7 minutes back');
  const excluded = store.allItemsNeedingRescope(box.board);
  assert.equal(excluded[0].id, id);
  assert.ok(excluded[0].reasons[0].includes(': ROUTED_ELSEWHERE'));
  assert.equal(Math.round((box.clock.now() - Date.parse(excluded[0].since)) / 60_000), 7);
  const finding = healthReport({ db: box.board.db, root: box.root, config: box.config, now: box.clock.now(), dispatchHealth }).stuck.find(row => row.cause === 'NEEDS_RESCOPE' && row.item === id);
  assert.match(finding.why, /released 7 min ago/u);
});

test('cli.journeys-next-take-part2.submit-merges-main-from-the-item: submit merges main from the item\'s own folder when the seat checkout has another source [B5,V4]', async t => {
  const result = await mainMoveWarningFixture(t);
  assert.deepEqual(result.warnings.find(warning => warning.item === result.id),
    { item: result.id, head: result.itemHead, trunk: result.trunk, files: ['web/shared.txt'] });
  assert.equal(result.shouts.length, 1);
  assert.equal(result.shouts[0].operation, 'shout');
  assertShoutNamesHead(result.shouts[0].args[0], result.id, result.itemHead, result.seatHead);

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
  assertShoutNamesHead(shouts[0].args[0], id, itemHead, result.seatHead);
});

test('cli.journeys-next-take-part2.a-queued-merge-repair-shout-keeps: a queued merge-repair shout keeps the captured submit source ahead of a newer item-folder head [B5,V4]', async t => {
  const result = await mainMoveWarningFixture(t, { queued: true });
  assert.deepEqual(result.warnings.find(warning => warning.item === result.id),
    { item: result.id, head: result.itemHead, trunk: result.trunk, files: ['web/shared.txt'] });
  assertShoutNamesHead(result.shouts[0].args[0], result.id, result.itemHead, result.seatHead);
});

test('cli.journeys-next-take-part2.next-after-a-release-from-an: clause 1: next after a release from an item folder that cleanup removed runs from the seat checkout and hands out work [B5,N2]', async t => {
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
