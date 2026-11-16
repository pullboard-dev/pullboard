/** @pullboard-test-input source-cell apps/cli apps/lib store moves */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/**
 * Latency of every board move on the large fixture board [C7]: each operation in the move registry is run in process
 * against a 2,500-item board, several times, and its p99 is printed. A registry move with no timing fails the check,
 * so a new move cannot join the registry unmeasured. The 200 ms assertion itself belongs to the parent item (#3190).
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { Refused } from '../../../../packages/kernel/index.js';
import { MOVE_OPERATIONS } from '../../../../packages/moves/index.js';
import { MOVE_REGISTRY } from '../../../../packages/moves/index.js';
import * as store from '../../../../packages/store/index.js';
import { openKitBoard } from '../../tests/fixtures/board.js';
import { largeBoard } from '../../tests/fixtures/board/large.js';

/** Timed attempts per move: enough to read a p99 off the slowest, few enough to stay inside the journey budget. */
const SAMPLES = 5;

/** The p99 of a sample list by the nearest-rank rule, in milliseconds. */
export function p99(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)];
}

/**
 * The registry moves that have no timing, in registry order.
 *
 * @param {string[]} operations every operation in the move registry
 * @param {Record<string, { samples: number[] }>} timings the measured moves by operation
 * @returns {string[]} operations with no samples
 */
export function untimedMoves(operations, timings) {
  return operations.filter(operation => !(timings[operation]?.samples?.length > 0));
}

/** Refuse when any registry move has no timing, naming each, so the registry and the measurement stay one list. */
export function requireEveryMoveTimed(operations, timings) {
  const missing = untimedMoves(operations, timings);
  if (missing.length) throw new Error(`these registry moves have no timing: ${missing.join(', ')}; add them to the latency journey`);
}

/** The arguments one move is attempted with: its item first when the registry says so, then an actor naming the coordinator. */
function attemptArgs(operation, itemId) {
  const actor = { agentId: 'coordinator', by: 'coordinator' };
  return MOVE_REGISTRY[operation].itemIdFirstArgument ? [itemId, actor] : [actor];
}

/** Time every registry move on the board; a refusal still counts, since the board paid for its reads before saying no. */
export function timeEveryMove(board, itemId, samples = SAMPLES) {
  const timings = {};
  for (const operation of MOVE_OPERATIONS) {
    const run = store[operation];
    const row = { samples: [], outcome: typeof run === 'function' ? 'ok' : 'unrunnable' };
    for (let n = 0; n < samples; n += 1) {
      const start = performance.now();
      try { run?.(board, ...attemptArgs(operation, itemId)); }
      catch (error) { row.outcome = error instanceof Refused ? 'refused' : 'error'; }
      row.samples.push(performance.now() - start);
    }
    row.p99 = p99(row.samples);
    timings[operation] = row;
  }
  return timings;
}

test('clause 1: every move in the move registry is timed on the large board and its p99 is printed [C7]', t => {
  const box = largeBoard(t);
  const board = openKitBoard(box.board);
  t.after(() => board.db.close());
  const itemId = Number(board.db.prepare('SELECT min(item_id) AS id FROM item').get().id);
  const timings = timeEveryMove(board, itemId);
  requireEveryMoveTimed(MOVE_OPERATIONS, timings);
  for (const operation of MOVE_OPERATIONS) t.diagnostic(`p99 ${timings[operation].p99.toFixed(1)} ms  ${operation} (${timings[operation].outcome})`);
  assert.ok(MOVE_OPERATIONS.length > 0);
  assert.equal(Object.keys(timings).length, MOVE_OPERATIONS.length);
});

test('clause 2: the check fails when a registry move has no timing [C7]', () => {
  const operations = ['claim', 'release', 'submit'];
  const timings = { claim: { samples: [1] }, release: { samples: [2] }, submit: { samples: [3] } };
  assert.deepEqual(untimedMoves(operations, timings), []);
  requireEveryMoveTimed(operations, timings);
  delete timings.release;
  assert.deepEqual(untimedMoves(operations, timings), ['release']);
  assert.throws(() => requireEveryMoveTimed(operations, timings), /no timing: release/u);
  assert.throws(() => requireEveryMoveTimed(operations, { ...timings, release: { samples: [] } }), /no timing: release/u);
});
