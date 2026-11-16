/** A real board with one claimed item under an exit policy, and native counters the test feeds it, for exit-rule stops [C7,#8553]. */
// fixture-subject: recordExitProgress
import { randomUUID } from 'node:crypto';
import { configFromSource } from '../../../../../packages/config/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { claim } from '../../../../../packages/store/index.js';
import { exitClaim } from '../../../../../packages/store/index.js';
import { itemThread } from '../../../../../packages/store/index.js';
import { recordExitProgress } from '../../../../../packages/store/index.js';
import { register } from '../../../../../packages/store/index.js';
import { release } from '../../../../../packages/store/index.js';
import { sealExitCheckpoints } from '../../../src/io/exit/checkpoint.js';
import { fixtureBoard } from '../board.js';
import { FIXTURE_MODEL } from '../../../../../packages/gate/tests/fixtures/testkit.js';

/** The structured summary an exit-rule stop releases with. */
export const SUMMARY = 'Done: wired the stop; Failed: none; Next: write the journey';

/**
 * One claimed item whose exit budget is 100 tokens and 3 calls, claimed under the policy a checkout with this configuration seals.
 *
 * @param {object} t The test context, for cleanup.
 * @param {string} source The checkout's pullboard.json text.
 * @returns {{ board: any, id: number, count: (native: { tokens: number, calls: number }) => void, stop: () => void, facts: () => string[] }}
 */
export function exitStopBoard(t, source) {
  const board = fixtureBoard(t), config = configFromSource(source);
  register(board, { id: 'coordinator', lane: 'coordinator', path: '/exit-fixture/main', session: 'fixture-coordinator', model: FIXTURE_MODEL });
  register(board, { id: 'core-1', lane: 'core', path: '/exit-fixture/one', family: 'openai', session: 'fixture-first', model: FIXTURE_MODEL });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Exit checkpoint', criterion: 'Retain the handoff.' });
  const policy = sealExitCheckpoints(config, { enabled: true, tokens: 100, calls: 3 });
  claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze: () => ({ text: '{}', digest: 'bar' }), exitRules: policy, exitClaimKey: randomUUID() });
  return {
    board, id,
    /** Publish the counters the session's native transcript reported. */
    count: native => recordExitProgress(board, { agentId: 'core-1', item: id, claim: exitClaim(board, id, 'core-1').key, ...native }),
    /** Stop the way the CLI's release does once the exit rule is reached. */
    stop: () => release(board, id, 'core-1', SUMMARY, 'BUDGET'),
    /** Every fact text on the item, oldest first. */
    facts: () => itemThread(board, id).filter(row => row.type === 'fact').map(row => row.text),
  };
}
