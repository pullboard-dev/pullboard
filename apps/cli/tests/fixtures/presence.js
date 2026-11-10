/** Real private Git/SQLite boards with a hand-turned clock; no gate receipt is fabricated. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  appliedSequence,
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { sentinelCommand } from '../../../../packages/sentinels/index.js';
import { createE2eHelpers } from './e2e.js';

/** Create normal registered seats and expose the real sentinel command over ordered engine moves. */
export function goneClaimFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', undefined, { withWorktree: false });
  let at = Date.parse('2026-10-27T12:00:00Z');
  const clock = { now: () => new Date(at) };
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), clock, { gitRoot: box.repo });
  t.after(() => store.closeBoard(board));
  const owner = store.register(board, { lane: 'web', path: join(box.dir, 'owner') });
  const other = store.register(board, { lane: 'web', path: join(box.dir, 'other') });
  /** Freeze a private board criterion without claiming an executed gate. */
  const freeze = item => ({ text: item.item_title, digest: `fixture:${item.item_title}` });
  /** Add and claim through the same board transitions as the CLI. */
  const claim = (title = 'Gone work', agentId = owner) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
    store.claim(board, id, { agentId, lane: 'web', leaseMs: 7_200_000, freeze });
    return id;
  };
  const moves = [];
  /** Apply a real versioned ordered move; retain it for replica replay assertions. */
  const ordered = async (_ctx, target, operation, args) => {
    // The automatic stale-state sweep (quiet-seat, idle and lease rules) rides this sentinel run, and has its own cases in
    // apps/cli/journeys/init/claims.test.js; here it is left out so only the opt-in gone release can act on the half-hour clock.
    if (operation === 'maintainStaleState') return undefined;
    const move = prepareEngineMove(target, operation, args);
    const options = { sequence: appliedSequence(target) + 1, at: clock.now().toISOString() };
    const outcome = applyEngineMove(target, move, options);
    assert.equal(outcome.error, undefined, JSON.stringify(outcome.error));
    moves.push({ move, options });
    return outcome.result;
  };
  /** Exercise the public sentinel handler with health scanning explicitly off in this private fixture. */
  const scan = async (enabled = true, actor = 'coordinator') => {
    // Coordinator maintenance captures native stale-state evidence even when watch execution is disabled.
    const ctx = { info: { root: box.repo, isMain: true }, clock,
      config: { claims: { releaseGone: enabled }, health: { sentinel: false } }, io: { say() {}, result() {} } };
    return sentinelCommand({ ctx, words: ['run'], values: { 'health-only': true },
      withBoard: (_ctx, work) => work(board), whoAmI: () => ({ id: actor }), ordered });
  };
  /** Move only the injected private board clock; no wall-clock sleeps or metadata changes. */
  const advance = ms => { at += ms; };
  return { board, box, owner, other, clock, claim, scan, moves, freeze, advance };
}
