/** Plain ports for the moves front door's nextOnce on a cell fixture board: pure, no CLI, no spawn [C7]. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../store/index.js';
import { loadConfig } from '../../../config/index.js';
import { headCommit } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { CELL_CONFIG } from '../../../store/tests/fixtures/cell.js';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';
import { nextTake } from '../../../sandbox/index.js';
import { nextOnce } from '../../index.js';

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
 * sameFamily, outside), `family` and `policy` set the project's review rules, and `lanes` adds lanes to the config. `box.as(name)` makes another seat the one that runs next.
 */
export function fixture(t, { reviewers = false, family, policy, route = 'strong', lanes } = {}) {
  const config = {};
  if (family || policy) config.verify = { policy: policy ?? 'any', family: family ?? 'off' };
  if (reviewers) config.lanes = { ...CELL_CONFIG.lanes, review: { owns: [] } };
  if (lanes) config.lanes = { ...(config.lanes ?? CELL_CONFIG.lanes), ...lanes };
  const project = cellProject(t, { real: true, config });
  let at = Date.parse('2026-10-25T10:00:00.000Z');
  const clock = { now: () => new Date(at) };
  const board = cellBoard(t, project.boardFile, clock, { real: true, gitRoot: project.repo });
  const builderPath = join(project.dir, 'builder');
  mkdirSync(builderPath);
  const seats = { actor: cellSeat(board, { lane: 'web', path: project.repo, family: 'Family Alpha', route }),
    builder: cellSeat(board, { lane: 'web', path: builderPath, family: 'Family Alpha' }) };
  if (reviewers) {
    store.board_ensureCoordinator(board, join(project.dir, 'coordinator'));
    for (const [name, vendor] of [['sibling', 'Family Beta'], ['sameFamily', 'Family Alpha'], ['outside', 'Family Beta']]) {
      const path = join(project.dir, name);
      mkdirSync(path);
      seats[name] = cellSeat(board, { lane: 'review', path, family: vendor });
    }
  }
  for (const seat of Object.values(seats)) store.heartbeatSeat(board, seat.id);
  let current = seats.actor;
  const ctx = { info: repoInfo(project.repo), config: loadConfig(project.repo), clock, file: project.boardFile, io: { err() {}, say() {} } };
  /** The claim's view of the seat's checkout: its head and a digest of it, as a clean checkout reads. */
  const snapshot = () => {
    const head = headCommit(project.repo);
    return { head, digest: createHash('sha256').update(head).digest('hex') };
  };
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
      Object.values(seats).find(seat => seat.id === agentId), { root: project.repo, leaseMs, autoNext, ...(autoNext ? { autoNextSnapshot: snapshot() } : {}) }),
    currentReworkRoutingPolicy: () => null,
    MainSpecMerged: class MainSpecMerged extends Error {},
    checkMainVerifier() {},
    dirtyFiles: () => [],
    openItemFolder: async () => undefined,
    liveFolderRefusal: async () => null,
    mainLaneWork: () => null,
    claimWorktreeSnapshot: snapshot,
  };
  /** Claim an item for a seat, as a peer racing the running seat would. */
  const claim = (id, seat = seats.builder) => store.claim(board, id, { agentId: seat.id, lane: seat.lane, leaseMs: 3_600_000, freeze: item => {
    const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  } });
  const git = (...args) => project.git(project.repo, ...args);
  return {
    board, seats, ctx, ports, project, advance: ms => { at += ms; }, claim, git, clock, root: project.repo, config: ctx.config,
    /** Make a seat the one that runs next from now on, by its name here or as a registered seat with an id and a lane. */
    as: who => { current = typeof who === 'string' ? seats[who] : who; },
    /** File an ordinary runnable item in the actor's lane, or another configured lane. */
    add: (title, options = {}) => {
      const item = cellItem(board, { lane: 'web', title, criterion: 'The real fixture succeeds.', check: 'true', specIds: ['G1'],
        brief: `Files: ${options.lane === 'docs' ? 'docs' : 'web'}/dispatch.js\nTest: the real board selects the eligible item and retains its ownership.`,
        ...options, ...(options.route === 'light' ? { route: 'mid' } : {}) });
      if (options.route === 'light') {
        // A light item is a mid item with a builder diagnosis, moved down to the light route.
        store.appendFact(board, item.item_id, { agentId: seats.builder.id, kind: 'diagnosis',
          text: 'Files: web/dispatch.js\nChange: prepare a small dispatch fixture\nTest case: native next assigns the item to an eligible seat.' });
        if (store.getItem(board, item.item_id).item_route !== 'light') {
          store.editItem(board, item.item_id, { agentId: 'coordinator', route: 'light', reason: 'Private light dispatch fixture' });
        }
      }
      return item.item_id;
    },
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
    // The command reports a review step for --verify even when the move leaves the flag unset.
    if (!found.retry) return found.item ? { ...found, review: found.review ?? Boolean(flags.verify) } : found;
    if (found.skipItem) values = { ...values, omitIds: [...(values.omitIds ?? []), found.skipItem] };
  }
  throw new Error('next kept retrying');
}

/**
 * Run next --take loops until one is not a retry, as the command does, leaving out items a loop skipped. The sandbox
 * front door's nextTake runs on the fixture's ports, with no main red work and no review reopen to compute.
 */
export async function take(box) {
  const services = { ...box.ports, claimFreezer: () => undefined, mainRedReviewItems: () => [], mainRedReworkItems: () => [],
    agentSessionDigest: () => 'next-fixture-session', computedReturnArgs: (_, args) => args };
  let values = { take: true, observeIdle: true };
  for (let loop = 0; loop < 5; loop++) {
    const found = await nextTake(box.ctx, values, services);
    if (!found.retry) return found;
    if (found.skipItem) values = { ...values, omitIds: [...(values.omitIds ?? []), found.skipItem] };
  }
  throw new Error('next --take kept retrying');
}

/** The items the actor seat holds as build claims. */
export const actorClaims = box => store.listItems(box.board)
  .filter(item => item.item_status === 'claimed' && item.item_owner === box.seats.actor.id).map(item => item.item_id);
