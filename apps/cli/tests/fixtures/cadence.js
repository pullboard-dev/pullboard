/** A second acceptance inside the landing cadence offers one land job and the loopback runner lands it at once [B35,B3,R3]. */
import assert from 'node:assert/strict';
import * as nativeBoard from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import * as outbox from '../../../../packages/outbox/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { landAfterAcceptance } from '../../index.js';
import { reviveFixtureLocalRunner } from './runner/local-start.js';
import { whenRunnerSettles } from './runner/local-start.js';
import { join } from 'node:path';

const [root, item] = process.argv.slice(2);
/** Observe the same private native board without retaining a connection across landing work. */
function observe(read) {
  const board = nativeBoard.openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'));
  try { return read(board); } finally { store.closeBoard(board); }
}
const io = { ...outbox, cwd: root, nativeBoard, stdout: process.stdout, stderr: process.stderr,
  clock: { now: () => new Date() }, replayConflictRecord: outbox.replay,
  outboxPolicy: () => ({ acknowledgedOperations: outbox.ACKNOWLEDGED_OPERATIONS, outboxQueueable: outbox.outboxQueueable }),
  say() {}, err: console.error };
reviveFixtureLocalRunner(root, process.env);
const offered = await landAfterAcceptance({ info: repoInfo(root), io });
assert.ok(offered, 'the acceptance offers its land job');
// A landing the automatic lander starts after an accept never waits on the cadence (360988c63f): the runner lands it at once.
const merged = await whenRunnerSettles(process.env, () => observe(board => store.getItem(board, Number(item))).item_merged_commit, { deadlineMs: 120_000, what: `#${item} lands` }); // budget: runaway ceiling for one loopback land job.
assert.ok(merged, 'the second acceptance lands at once, inside the cadence');
