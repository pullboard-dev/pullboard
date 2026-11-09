/** Plain ports for the moves front door's nextOnce on a cell fixture board: pure, no CLI, no spawn [C7]. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../store/index.js';
import { loadConfig } from '../../config/index.js';
import { repoInfo } from '../../git/index.js';
import { CELL_CONFIG } from '../../../test/cell-fixture.js';
import { cellBoard } from '../../../test/cell-fixture.js';
import { cellClaim } from '../../../test/cell-fixture.js';
import { cellItem } from '../../../test/cell-fixture.js';
import { cellProject } from '../../../test/cell-fixture.js';
import { cellSeat } from '../../../test/cell-fixture.js';
import { submitFixture } from '../../../test/board-submit-fixture.js';
import { nextOnce } from '../index.js';

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
 * A real repo and board with an actor seat at the repo root and a peer builder in the same lane, and plain ports in
 * place of the command line's: board work on the open board, the current seat as this seat, claims through the claim
 * move, and no item folders. With `reviewers`, the coordinator and three review-lane seats join too (sibling,
 * sameFamily, outside), and `family` and `policy` set the project's review rules. `box.as(name)` makes another seat the one that runs next.
 */
export function fixture(t, { reviewers = false, family, policy } = {}) {
  const config = {};
  if (family || policy) config.verify = { policy: policy ?? 'any', family: family ?? 'off' };
  if (reviewers) config.lanes = { ...CELL_CONFIG.lanes, review: { owns: [] } };
  const project = cellProject(t, { config });
  let at = Date.parse('2026-10-25T10:00:00.000Z');
  const clock = { now: () => new Date(at) };
  const board = cellBoard(t, project.boardFile, clock, { gitRoot: project.repo });
  const builderPath = join(project.dir, 'builder');
  mkdirSync(builderPath);
  const seats = { actor: cellSeat(board, { lane: 'web', path: project.repo, family: 'Family Alpha' }),
    builder: cellSeat(board, { lane: 'web', path: builderPath, family: 'Family Alpha' }) };
  if (reviewers) {
    store.board_ensureCoordinator(board, project.repo);
    for (const [name, vendor] of [['sibling', 'Family Beta'], ['sameFamily', 'Family Alpha'], ['outside', 'Family Beta']]) {
      const path = join(project.dir, name);
      mkdirSync(path);
      seats[name] = cellSeat(board, { lane: 'review', path, family: vendor });
    }
  }
  for (const seat of Object.values(seats)) store.heartbeatSeat(board, seat.id);
  let current = seats.actor;
  const ctx = { info: repoInfo(project.repo), config: loadConfig(project.repo), clock, file: project.boardFile, io: { err() {}, say() {} } };
  const ports = {
    withBoardRead: (_, work) => work(board),
    withBoard: (_, work) => work(board),
    whoAmI: () => {
      const row = store.agentById(board, current.id);
      return { id: row.agent_id, lane: row.agent_lane, route: row.agent_route, family: row.agent_family, model: row.agent_model };
    },
    idArg: value => Number(value),
    ordered: (_, open, operation, args) => store[operation](open, ...args),
    claimOrdered: (_, open, [id, { agentId, leaseMs, autoNext }]) => cellClaim(open, id,
      Object.values(seats).find(seat => seat.id === agentId), { root: project.repo, leaseMs, autoNext }),
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
  /** Claim an item for a seat, as a peer racing the running seat would. */
  const claim = (id, seat = seats.builder) => store.claim(board, id, { agentId: seat.id, lane: seat.lane, leaseMs: 3_600_000, freeze: item => {
    const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  } });
  const git = (...args) => project.git(project.repo, ...args);
  return {
    board, seats, ctx, ports, project, advance: ms => { at += ms; }, claim, git, clock, root: project.repo, config: ctx.config,
    /** Make a named seat the one that runs next from now on. */
    as: name => { current = seats[name]; },
    /** File an ordinary runnable item in the actor's lane, or another configured lane. */
    add: (title, options = {}) => cellItem(board, { lane: 'web', title, criterion: 'The real fixture succeeds.', check: 'true', specIds: ['G1'],
      brief: `Files: ${options.lane === 'docs' ? 'docs' : 'web'}/dispatch.js\nTest: the real board selects the eligible item and retains its ownership.`, ...options }).item_id,
    /** Publish synthetic board state at the repo's head as the builder's submission, with no gate receipt. */
    submit: id => {
      claim(id);
      const head = git('rev-parse', 'HEAD');
      submitFixture(board, id, { agentId: seats.builder.id, commit: head, tree: git('rev-parse', `${head}^{tree}`) });
    },
  };
}

/**
 * Run next loops until one is not a retry, as the command does, leaving out items a loop skipped. The flags are the
 * command's (build, verify, wait); with none, it is the plain default loop.
 */
export async function next(box, flags = {}) {
  const plain = !flags.build && !flags.verify && flags.verifyId === undefined && flags.wait === undefined;
  let values = { ...flags, defaultLoop: plain, observeIdle: true };
  for (let loop = 0; loop < 5; loop++) {
    const found = await nextOnce(box.ctx, values, box.ports);
    if (!found.retry) return found;
    if (found.skipItem) values = { ...values, omitIds: [...(values.omitIds ?? []), found.skipItem] };
  }
  throw new Error('next kept retrying');
}

/** The items the actor seat holds as build claims. */
export const actorClaims = box => store.listItems(box.board)
  .filter(item => item.item_status === 'claimed' && item.item_owner === box.seats.actor.id).map(item => item.item_id);
