/** next --take selects once on its read snapshot; the write runs only the chosen item's guards [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import { loadConfig } from '../../config/index.js';
import { repoInfo } from '../../git/index.js';
import { cellBoard } from '../../../test/cell-fixture.js';
import { cellClaim } from '../../../test/cell-fixture.js';
import { cellItem } from '../../../test/cell-fixture.js';
import { cellProject } from '../../../test/cell-fixture.js';
import { cellSeat } from '../../../test/cell-fixture.js';
import { nextTake } from '../src/shell/next-take.js';
import { takeSelection } from '../src/shell/next-take.js';

/** Count calls to each entry of a selection seam, optionally running a hook after each, and restore it after the test. */
function counted(t, seam, after = {}) {
  const counts = Object.fromEntries(Object.keys(seam).map(name => [name, 0]));
  const original = { ...seam };
  for (const name of Object.keys(seam)) {
    seam[name] = (...args) => {
      counts[name]++;
      const value = original[name](...args);
      after[name]?.(value, counts[name]);
      return value;
    };
  }
  t.after(() => Object.assign(seam, original));
  return counts;
}

/**
 * A real repo and board with an actor seat at the repo root and a peer builder in the same lane, and the plain take
 * services nextTake runs with: board work on the open board, the actor as this seat, and claims through the claim move.
 */
function fixture(t) {
  const project = cellProject(t);
  let at = Date.parse('2026-10-25T10:00:00.000Z');
  const clock = { now: () => new Date(at) };
  const board = cellBoard(t, project.boardFile, clock, { gitRoot: project.repo });
  const builderPath = join(project.dir, 'builder');
  mkdirSync(builderPath);
  const seats = { actor: cellSeat(board, { lane: 'web', path: project.repo }), builder: cellSeat(board, { lane: 'web', path: builderPath }) };
  for (const seat of Object.values(seats)) store.heartbeatSeat(board, seat.id);
  const ctx = { info: repoInfo(project.repo), config: loadConfig(project.repo), clock, file: project.boardFile, io: { err() {}, say() {} } };
  const services = {
    withBoardRead: (_, work) => work(board),
    withBoard: (_, work) => work(board),
    whoAmI: () => store.agentById(board, seats.actor.id),
    idArg: value => Number(value),
    checkMainVerifier() {},
    claimFreezer: () => undefined,
    claimOrdered: (_, open, [id, { agentId, leaseMs, autoNext }]) => cellClaim(open, id, agentId === seats.actor.id ? seats.actor : seats.builder,
      { root: project.repo, leaseMs, autoNext }),
    ordered: (_, open, operation, args) => store[operation](open, ...args),
    mainRedReviewItems: () => [],
    mainRedReworkItems: () => [],
    agentSessionDigest: () => 'take-selects-once-session',
    MainSpecMerged: class MainSpecMerged extends Error {},
  };
  return {
    board, seats, ctx, services, advance: ms => { at += ms; },
    /** File an ordinary runnable item in the actor's lane. */
    add: (title, options = {}) => cellItem(board, { lane: 'web', title, criterion: 'The real fixture succeeds.', check: 'true', specIds: ['G1'],
      brief: 'Files: web/dispatch.js\nTest: the real board selects the eligible item and retains its ownership.', ...options }).item_id,
    /** Claim an item for a seat, as a peer racing this seat would. */
    claim: (id, seat = seats.builder) => store.claim(board, id, { agentId: seat.id, lane: seat.lane, leaseMs: 3_600_000, freeze: item => {
      const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    } }),
  };
}

/** Run next --take loops until one is not a retry, as the command does, leaving out items a loop skipped. */
async function take(box) {
  let values = { take: true, observeIdle: true };
  for (let loop = 0; loop < 5; loop++) {
    const found = await nextTake(box.ctx, values, box.services);
    if (!found.retry) return found;
    if (found.skipItem) values = { ...values, omitIds: [...(values.omitIds ?? []), found.skipItem] };
  }
  throw new Error('next --take kept retrying');
}

/** The items the actor seat holds as build claims. */
const actorClaims = box => store.listItems(box.board)
  .filter(item => item.item_status === 'claimed' && item.item_owner === box.seats.actor.id).map(item => item.item_id);

test('next --take calls its selection and review offer once each [C7]', async t => {
  const box = fixture(t);
  const first = box.add('First open item');
  box.add('Second open item');
  const counts = counted(t, takeSelection);
  const taken = await take(box);
  assert.equal(taken.item.item_id, first);
  assert.deepEqual(counts, { selected: 1, reviewOffer: 1 }, 'the write transaction selected nothing');
});

test('a holding seat returns its claim from next --take without the mandatory review offer [C7]', async t => {
  const box = fixture(t);
  const held = box.add('Already held');
  box.add('Another open item');
  box.claim(held, box.seats.actor);
  const counts = counted(t, takeSelection);
  const taken = await take(box);
  assert.equal(taken.item.item_id, held);
  assert.deepEqual(counts, { selected: 1, reviewOffer: 0 });
  assert.deepEqual(actorClaims(box), [held]);
});

test('next --take: the write runs only the chosen item claim guards and selects again only when they refuse [C7]', async t => {
  const box = fixture(t);
  const raced = box.add('Raced by a peer');
  const spare = box.add('Still free', { brief: 'Files: web/spare.js\nTest: the real board claims the spare item.' });
  // A peer claims the chosen item after the read selection and before the write's claim guards run.
  const counts = counted(t, takeSelection, { selected: (value, call) => { if (call === 1) box.claim(value.item.item_id); } });
  const result = await take(box);
  assert.equal(store.getItem(box.board, raced).item_owner, box.seats.builder.id, 'the peer keeps the raced item');
  assert.equal(result.item.item_id, spare);
  assert.deepEqual(actorClaims(box), [spare]);
  assert.equal(counts.selected, 2, 'one read selection per loop, none inside a write');
});
