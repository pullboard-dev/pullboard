/** Plain ports for the sandbox front door's nextTake on a cell fixture board: pure, no CLI, no spawn [C7]. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../store/index.js';
import { loadConfig } from '../../../config/index.js';
import { repoInfo } from '../../../git/index.js';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { nextTake } from '../../src/io/take.js';

/** Count calls to each entry of a selection seam, optionally running a hook after each, and restore it after the test. */
export function counted(t, seam, after = {}) {
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
 * A real repo and board with an actor seat and a peer builder in the same lane, each in a folder of its own, and the
 * plain take services nextTake runs with: board work on the open board, the current seat as this seat, and claims
 * through the claim move. `box.as(name)` makes another seat the one that runs next.
 */
export function fixture(t) {
  const project = cellProject(t);
  let at = Date.parse('2026-10-25T10:00:00.000Z');
  const clock = { now: () => new Date(at) };
  const board = cellBoard(t, project.boardFile, clock, { gitRoot: project.repo });
  const seats = {};
  for (const name of ['actor', 'builder']) {
    const path = join(project.dir, name);
    mkdirSync(path);
    seats[name] = cellSeat(board, { lane: 'web', path });
  }
  for (const seat of Object.values(seats)) store.heartbeatSeat(board, seat.id);
  let current = seats.actor;
  const ctx = { info: repoInfo(project.repo), config: loadConfig(project.repo), clock, file: project.boardFile, io: { err() {}, say() {} } };
  const services = {
    withBoardRead: (_, work) => work(board),
    withBoard: (_, work) => work(board),
    whoAmI: () => {
      const row = store.agentById(board, current.id);
      return { id: row.agent_id, lane: row.agent_lane, route: row.agent_route, family: row.agent_family, model: row.agent_model };
    },
    idArg: value => Number(value),
    checkMainVerifier() {},
    claimFreezer: () => undefined,
    claimOrdered: (_, open, [id, { agentId, leaseMs, autoNext }]) => cellClaim(open, id, Object.values(seats).find(seat => seat.id === agentId),
      { root: project.repo, leaseMs, autoNext }),
    ordered: (_, open, operation, args) => store[operation](open, ...args),
    mainRedReviewItems: () => [],
    mainRedReworkItems: () => [],
    agentSessionDigest: () => 'take-selects-once-session',
    MainSpecMerged: class MainSpecMerged extends Error {},
  };
  return {
    board, seats, ctx, services, advance: ms => { at += ms; },
    /** Make a seat the one that runs next from now on. */
    as: name => { current = seats[name]; },
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
export async function take(box) {
  let values = { take: true, observeIdle: true };
  for (let loop = 0; loop < 5; loop++) {
    const found = await nextTake(box.ctx, values, box.services);
    if (!found.retry) return found;
    if (found.skipItem) values = { ...values, omitIds: [...(values.omitIds ?? []), found.skipItem] };
  }
  throw new Error('next --take kept retrying');
}

/** The items the actor seat holds as build claims. */
export const actorClaims = box => store.listItems(box.board)
  .filter(item => item.item_status === 'claimed' && item.item_owner === box.seats.actor.id).map(item => item.item_id);
