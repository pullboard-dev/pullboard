/** @pullboard-test-input source-tree */
/** Busy builders take starved reviews: a held claim no longer hides a review that waited past the limit [C7,N2,V1]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import * as store from '../../../../packages/store/index.js';

/** Claim through the real CLI so the seat gets its item folder, and return the folder path the CLI printed. */
async function claimed(box, seat, id) {
  const result = await cli(box, seat.path, ['claim', String(id), '--no-next']);
  assert.equal(result.code, 0, result.out + result.err);
  const item = store.getItem(box.board, id);
  assert.equal(item.item_status, 'claimed');
  assert.equal(item.item_owner, seat.id);
  return item;
}

/** The shared fixture with its board bound to the repository, as a modern submit requires. */
async function board(t) {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  return box;
}

/** The held claim's lease and item folder, read straight from the board and the disk. */
function holding(box, seat, id) {
  const item = store.getItem(box.board, id);
  return { status: item.item_status, owner: item.item_owner, lease: item.item_lease_until,
    folder: existsSync(`${seat.path}-item-${id}`) };
}

test('clause 3: a seat holding one claim and a seat holding two each get the starved review first at the five-minute default; the builds stay held [C7,N2,V1]', async t => {
  const box = await board(t);
  // This case makes the review-lane seat a builder too, so its declared build files have an owner.
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.lanes.review.owns = ['review/'];
  writeFileSync(configFile, JSON.stringify(config));
  box.git(box.root, 'add', 'pullboard.json');
  box.git(box.root, 'commit', '-q', '-m', 'chore: assign review fixture files [G1]');
  for (const seat of Object.values(box.seats)) box.git(seat.path, 'merge', '-q', '--ff-only', 'main');
  const waiting = box.add('Submission waiting past the review limit');
  box.submit(waiting);
  const one = box.add('Build held by the one-claim seat', { brief: 'Files: web/one.js\nTest: the held build keeps its lease.' });
  await claimed(box, box.seats.actor, one);
  const first = box.add('First build of the two-claim seat', { lane: 'review', brief: 'Files: review/first.js\nTest: held.' });
  const second = box.add('Second build of the two-claim seat', { lane: 'review', brief: 'Files: review/second.js\nTest: held.' });
  await claimed(box, box.seats.outside, first);
  await claimed(box, box.seats.outside, second);
  const before = { one: holding(box, box.seats.actor, one), first: holding(box, box.seats.outside, first), second: holding(box, box.seats.outside, second) };
  assert.equal(before.one.folder, true, 'claim opened the item folder');
  box.advance(11 * 60_000);

  for (const [seat, kept] of [[box.seats.actor, one], [box.seats.outside, first]]) {
    const offered = await cli(box, seat.path, ['next', '--wait', '0']);
    assert.equal(offered.code, 0, offered.out + offered.err);
    assert.equal(offered.document.item.item_id, waiting, 'the starved review comes before the held build');
    assert.equal(offered.document.review, true);
    assert.equal(offered.document.buildHeld, true);
    assert.equal(offered.document.build.item_id, kept);
  }
  const said = await main(box, box.seats.actor.path, ['next', '--wait', '0']);
  assert.match(said, /waited over 5 minutes without a reviewer/u);
  assert.match(said, new RegExp(`build #${one} stays held with its lease and folder; after the verdict, pullboard next resumes it`, 'u'));
  assert.deepEqual({ one: holding(box, box.seats.actor, one), first: holding(box, box.seats.outside, first), second: holding(box, box.seats.outside, second) },
    before, 'offering the review leaves every held claim, lease and folder untouched');

  const reserved = await cli(box, box.seats.actor.path, ['next', '--verify', String(waiting)]);
  assert.equal(reserved.code, 0, reserved.out + reserved.err);
  assert.equal(reserved.document.item.item_id, waiting);
  assert.equal(reserved.document.review, true);
  assert.deepEqual(holding(box, box.seats.actor, one), before.one, 'reserving the review keeps the held build');
  const resumed = await cli(box, box.seats.outside.path, ['next']);
  assert.equal(resumed.code, 0, resumed.out + resumed.err);
  assert.equal(resumed.document.item.item_id, first, 'once another seat reviews it, the held build resumes');
  assert.equal(resumed.document.review, false);
});

test('a review waiting under the limit is not offered to a seat that holds a claim [C7,N2,V1]', async t => {
  const box = await board(t);
  const waiting = box.add('Submission still under the review limit');
  box.submit(waiting);
  const one = box.add('Build held by the busy seat', { brief: 'Files: web/one.js\nTest: the held build keeps its lease.' });
  await claimed(box, box.seats.actor, one);
  const before = holding(box, box.seats.actor, one);
  box.advance(4 * 60_000);
  const next = await cli(box, box.seats.actor.path, ['next', '--wait', '0']);
  assert.equal(next.code, 0, next.out + next.err);
  assert.equal(next.document.item.item_id, one, 'the held build resumes; the fresh review waits for a free seat');
  assert.equal(next.document.review, false);
  assert.equal(next.document.held, true);
  assert.equal(holding(box, box.seats.actor, one).folder, before.folder);
  assert.equal(holding(box, box.seats.actor, one).owner, box.seats.actor.id);
});

/** The human-readable lines of one command, without --json. */
async function main(box, cwd, args) {
  const { main: run } = await import('../../tests/fixtures/native.js');
  let out = '';
  const code = await run(args, { cwd, clock: box.clock, stdout: { isTTY: false, write: part => { out += part; } }, stderr: { write: () => {} } });
  assert.equal(code, 0, out);
  return out;
}
