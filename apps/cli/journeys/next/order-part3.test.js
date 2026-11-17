/** Next order: path, milestone and lane hand-off precedence [N2,B13,B16]. */
import { openBoard } from '../../../lib/index.js';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { join } from 'node:path';

test('cli.journeys-next-order-part3.an-agent-exhausts-ready-own-lane: an agent exhausts ready own-lane work, then names another lane\'s item without claiming it [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const web = box.json((await box.runAsLocal(box.session, box.web, 'join', 'web', '--model', 'fixture-model', '--lock-lane', '--json')));
  const peer = box.seat('peer-api', 'api', 'unrelated-session');
  const peerBinding = box.binding(peer.root);
  const api = box.seat('owned-api', 'api', box.session);
  const later = box.add('web', 'Later web work');
  const first = box.add('api', 'Earlier API release');
  box.milestone('first', first);
  box.milestone('later', later);

  const own = box.json((await box.runAsLocal(box.session, box.web, 'next', '--build', '--json')));
  assert.equal(own.item.item_id, later, 'ready own-lane work precedes an earlier release in another lane');
  assert.equal(own.item.item_owner, web.agent);
  assert.equal(own.seat, undefined, 'the claim stays with the seat that ran next');
  box.json((await box.runAsLocal(box.session, box.web, 'release', String(later), '--reason', 'BLOCKED', '--no-next', '--json')));
  box.json((await box.runLocal(box.repo, 'hold', String(later), '--reason', 'Own-lane work is intentionally blocked', '--json')));
  const seats = async () => box.json((await box.runLocal(box.repo, 'seats', '--json'))).seats.map(row => row.seat).sort();
  const before = await seats();
  const named = (await box.runAsLocal(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(named.code, 1, 'an idle lane claims nothing in another lane');
  const message = JSON.parse(named.out).error.message;
  assert.match(message, new RegExp(`#${first}\\b.*api lane`, 'u'), `next names the other lane's item and lane: ${message}`);
  assert.equal(box.json((await box.runLocal(box.repo, 'show', String(first), '--json'))).item_status, 'open', 'the named item stays unclaimed');
  assert.deepEqual(await seats(), before, 'no seat is created or borrowed');
  assert.deepEqual(box.binding(peer.root), peerBinding, 'another session’s seat is never borrowed or rebound');
  const claimed = box.json((await box.runAsLocal(box.session, api.root, 'next', '--build', '--json')));
  assert.equal(claimed.item.item_id, first, 'the API seat claims the API item itself');
  assert.equal(claimed.item.item_owner, api.agent);
  const sibling = (await box.runAsLocal(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(sibling.code, 1, 'the idle sibling never resumes the API seat’s claim (#958)');
  box.json((await box.runLocal(box.repo, 'hold', String(later), '--off', '--json')));
  const wrongLane = (await box.runAsLocal(box.session, api.root, 'claim', String(later), '--json'));
  assert.equal(wrongLane.code, 1);
  assert.equal(JSON.parse(wrongLane.out).error.code, 'WRONG_LANE', 'a seat’s write authority stays its own lane');
  assert.notEqual(web.agent, api.agent);
});

test('cli.journeys-next-order-part3.a-seat-that-holds-nothing-is: a seat that holds nothing is never told it holds another seat\'s claim [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const holder = box.seat('claim-holder', 'web', box.session);
  const idle = box.seat('claim-idle', 'web', box.session);
  const bystander = box.seat('claim-bystander', 'api', box.session);
  const held = box.add('web', 'Held by the first seat');
  box.json((await box.runAsLocal(box.session, holder.root, 'claim', String(held), '--json')));
  for (const seat of [idle, bystander]) {
    const next = (await box.runAsLocal(box.session, seat.root, 'next', '--build', '--json'));
    const text = `${next.out}\n${next.err}`;
    assert.doesNotMatch(text, /you hold #/u, `${seat.agent} is never told it holds the claim of ${holder.agent}`);
    assert.equal(text.includes(holder.root), false, `${seat.agent} is never sent to ${holder.agent}'s checkout`);
    if (next.code === 0) assert.notEqual(JSON.parse(next.out).item.item_id, held, 'the held item is not offered again');
  }
  const own = box.json((await box.runAsLocal(box.session, holder.root, 'next', '--build', '--json')));
  assert.equal(own.item.item_id, held, 'the holding seat is still told it holds its item');
  assert.equal(own.held, true);
});

test('cli.journeys-next-order-part3.next-names-the-lane-to-open: next names the lane to open for work the agent lacks, and creates no seat [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const web = box.seat('owned-mid-web', 'web', box.session, 'mid', true);
  const peer = box.seat('peer-api', 'api', 'unrelated-session');
  const peerBinding = box.binding(peer.root);
  const tooStrong = box.add('api', 'A strong-only earlier release');
  const first = box.add('api', 'Available mid API work', 'mid');
  box.milestone('strong-only', tooStrong);
  box.milestone('first-eligible', first);
  const before = box.git(box.repo, 'worktree', 'list', '--porcelain');
  const seatsBefore = box.json((await box.runLocal(box.repo, 'seats', '--json'))).seats.map(row => row.seat).sort();

  const next = (await box.runAsLocal(box.session, web.root, 'next', '--build', '--json'));
  assert.equal(next.code, 1, next.out);
  const error = JSON.parse(next.out).error;
  assert.match(error.message, new RegExp(`#${first}\\b.*api lane`, 'u'), 'the route still skips stronger work and names the eligible item');
  assert.match(error.message, /pullboard worktree api/u, 'and the command that opens a seat for that lane');
  assert.equal(box.git(box.repo, 'worktree', 'list', '--porcelain'), before, 'next opens no worktree');
  assert.deepEqual(box.json((await box.runLocal(box.repo, 'seats', '--json'))).seats.map(row => row.seat).sort(), seatsBefore, 'and joins no seat');
  assert.deepEqual(box.binding(peer.root), peerBinding);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    assert.equal(store.getItem(board, tooStrong).item_status, 'open');
    assert.equal(store.getItem(board, first).item_status, 'open', 'the named item stays unclaimed');
  } finally { store.closeBoard(board); }
  assert.ok(web.agent);
});
