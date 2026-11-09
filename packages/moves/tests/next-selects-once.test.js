/** next selects once on its read snapshot; the write runs only the chosen item's guards [C7]. The --take cases live in the sandbox cell. */
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
import { nextOnce } from '../index.js';
import { nextSelection } from '../index.js';

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
 * A real repo and board with an actor seat at the repo root and a peer builder in the same lane, and plain ports in
 * place of the command line's: board work on the open board, the actor as this seat, claims through the claim move,
 * and no item folders.
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
  const ports = {
    withBoardRead: (_, work) => work(board),
    withBoard: (_, work) => work(board),
    whoAmI: () => {
      const row = store.agentById(board, seats.actor.id);
      return { id: row.agent_id, lane: row.agent_lane, route: row.agent_route, family: row.agent_family, model: row.agent_model };
    },
    idArg: value => Number(value),
    ordered: (_, open, operation, args) => store[operation](open, ...args),
    claimOrdered: (_, open, [id, { agentId, leaseMs, autoNext }]) => cellClaim(open, id, agentId === seats.actor.id ? seats.actor : seats.builder,
      { root: project.repo, leaseMs, autoNext }),
    currentReworkRoutingPolicy: () => null,
    MainSpecMerged: class MainSpecMerged extends Error {},
    checkMainVerifier() {},
    dirtyFiles: () => [],
    recoverOwnSubmitHandoffs: async () => {},
    openItemFolder: async () => undefined,
    liveFolderRefusal: async () => null,
    mainLaneWork: () => null,
    claimWorktreeSnapshot: () => null,
  };
  return {
    board, seats, ctx, ports, project, advance: ms => { at += ms; },
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

/** Run plain next loops until one is not a retry, as the command does, leaving out items a loop skipped. */
async function next(box) {
  let values = { defaultLoop: true, observeIdle: true };
  for (let loop = 0; loop < 5; loop++) {
    const found = await nextOnce(box.ctx, values, box.ports);
    if (!found.retry) return found;
    if (found.skipItem) values = { ...values, omitIds: [...(values.omitIds ?? []), found.skipItem] };
  }
  throw new Error('next kept retrying');
}

/** The items the actor seat holds as build claims. */
const actorClaims = box => store.listItems(box.board)
  .filter(item => item.item_status === 'claimed' && item.item_owner === box.seats.actor.id).map(item => item.item_id);

test('next calls its selection and default-loop review offer once each [C7]', async t => {
  const box = fixture(t);
  const first = box.add('First open item');
  const second = box.add('Second open item');
  // The seat took and returned a claim before, as the command fixture's next --take did.
  cellClaim(box.board, first, box.seats.actor, { root: box.project.repo });
  store.release(box.board, first, box.seats.actor.id, 'Return the fixture claim for the plain next run', 'OTHER');
  box.advance(31 * 60_000);
  const plain = counted(t, nextSelection);
  const found = await next(box);
  assert.ok([first, second].includes(found.item?.item_id), JSON.stringify(found));
  // Plain next is the default loop: its one review offer is the default-loop review, never the build-intent offer (deb8696e48).
  assert.deepEqual(plain, { pick: 1, reviewOffer: 0, defaultOffer: 1 }, 'nextPick ran once, outside the write');
});

test('a holding seat returns its claim from next without another selection [C7]', async t => {
  const box = fixture(t);
  const held = box.add('Already held');
  box.add('Another open item');
  box.claim(held, box.seats.actor);
  const plain = counted(t, nextSelection);
  const found = await next(box);
  assert.equal(found.item?.item_id, held, JSON.stringify(found));
  assert.deepEqual(plain, { pick: 1, reviewOffer: 0, defaultOffer: 1 });
  assert.deepEqual(actorClaims(box), [held]);
});

test('next: the write runs only the chosen item claim guards and selects again only when they refuse [C7]', async t => {
  const box = fixture(t);
  const raced = box.add('Raced by a peer');
  const spare = box.add('Still free', { brief: 'Files: web/spare.js\nTest: the real board claims the spare item.' });
  // A peer claims the chosen item after the read selection and before the write's claim guards run.
  const counts = counted(t, nextSelection, { pick: (value, call) => { if (call === 1) box.claim(value.item.item_id); } });
  const result = await next(box);
  assert.equal(store.getItem(box.board, raced).item_owner, box.seats.builder.id, 'the peer keeps the raced item');
  assert.equal(result.item?.item_id, spare, JSON.stringify(result));
  assert.deepEqual(actorClaims(box), [spare]);
  assert.equal(counts.pick, 2, 'one read selection per loop, none inside a write');
});
