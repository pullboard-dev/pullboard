/** Native landing is resumed by a captured wake with an injected board clock, never by editing board history [B35,B3,R3]. */
import assert from 'node:assert/strict';
import * as nativeBoard from '../src/native-board.js';
import * as store from '../packages/store/index.js';
import * as outbox from '../packages/outbox/index.js';
import { repoInfo } from '../packages/git/index.js';
import { landAfterAcceptance } from '../src/commands/land.js';
import { scheduleAutomaticLanding, resumeAutomaticLanding, automaticLandingDirectory } from '../packages/landing/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [root, item] = process.argv.slice(2);
/** Observe the same private native board without retaining a connection across native landing work. */
function observe(read) {
  const board = nativeBoard.openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'));
  try { return read(board); } finally { store.closeBoard(board); }
}
let now = Date.parse(observe(board => store.landingBatches(board).at(-1).startedAt));
const io = { ...outbox, cwd: root, nativeBoard, stdout: process.stdout, stderr: process.stderr,
  clock: { now: () => new Date(now) }, replayConflictRecord: outbox.replay,
  outboxPolicy: () => ({ acknowledgedOperations: outbox.ACKNOWLEDGED_OPERATIONS, outboxQueueable: outbox.outboxQueueable }),
  say() {}, err: console.error };
const ctx = { info: repoInfo(root), io };
let wakes = 0, authentications = 0;
/** Capture the timer boundary while retaining the production durable queue and exact native due time. */
const schedule = (project, due, worker) => scheduleAutomaticLanding(project, due, worker, {
  now: () => now,
  schedule: async () => { wakes++; },
});
await landAfterAcceptance(ctx, { schedule });
assert.equal(wakes, 1);
assert.equal(observe(board => store.getItem(board, Number(item))).item_merged_commit, null);
const file = join(automaticLandingDirectory(root), 'pending.json');
const job = JSON.parse(readFileSync(file, 'utf8'));
now = Date.parse(job.dueAt);
await resumeAutomaticLanding(root, 'fixture-authenticated-wake', job.dueAt, async () => landAfterAcceptance(ctx, { schedule }), {
  wait: async () => { authentications++; return true; },
});
assert.equal(authentications, 1);
assert.equal(wakes, 1, 'the mature wake needs no additional acceptance or timer');
assert.ok(observe(board => store.getItem(board, Number(item))).item_merged_commit, 'the ordinary native gate records the second landing');
assert.equal(existsSync(file), false);
