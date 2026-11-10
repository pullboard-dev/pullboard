/** Native landing is resumed by a captured wake with an injected board clock, never by editing board history [B35,B3,R3]. */
import assert from 'node:assert/strict';
import * as nativeBoard from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import * as outbox from '../../../../packages/outbox/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { landAfterAcceptance } from '../../index.js';
import {
  scheduleAutomaticLanding,
  automaticLandingDirectory,
} from '../../../../packages/landing/index.js';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  watch,
} from 'node:fs';
import { join } from 'node:path';

const [root, item, mode] = process.argv.slice(2);
/** Observe the same private native board without retaining a connection across native landing work. */
function observe(read) {
  const board = nativeBoard.openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'));
  try { return read(board); } finally { store.closeBoard(board); }
}
if (mode === 'real') {
  const directory = automaticLandingDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'pending.json'), watcher = watch(directory);
  let queued = false, check;
  const completed = new Promise((resolve, reject) => {
    /** Observe completion or a retained native error through file events, never a timing assertion. */
    check = () => {
      if (!queued) return;
      if (!existsSync(file)) return resolve();
      const job = JSON.parse(readFileSync(file, 'utf8'));
      if (job.error) reject(new Error(job.error));
    };
    watcher.on('change', check);
    watcher.on('error', reject);
  });
  try {
    await scheduleAutomaticLanding(root, new Date().toISOString(), new URL('../../src/io/landing/automatic.js', import.meta.url));
    queued = true;
    check();
    await completed;
    assert.ok(observe(board => store.getItem(board, Number(item))).item_merged_commit, 'the real detached worker runs the native landing gate');
    assert.equal(observe(board => store.events(board, { itemId: Number(item) }).filter(event => event.event_kind === 'merged').length), 1);
  } finally { watcher.close(); }
} else {
let now = Date.parse(observe(board => store.landingBatches(board).at(-1).startedAt));
const io = { ...outbox, cwd: root, nativeBoard, stdout: process.stdout, stderr: process.stderr,
  clock: { now: () => new Date(now) }, replayConflictRecord: outbox.replay,
  outboxPolicy: () => ({ acknowledgedOperations: outbox.ACKNOWLEDGED_OPERATIONS, outboxQueueable: outbox.outboxQueueable }),
  say() {}, err: console.error };
const ctx = { info: repoInfo(root), io };
let wakes = 0;
/** Capture the timer boundary while retaining the production durable queue and exact native due time. */
const schedule = (project, due, worker) => scheduleAutomaticLanding(project, due, worker, {
  now: () => now,
  schedule: async () => { wakes++; },
});
await landAfterAcceptance(ctx, { schedule });
// A landing the automatic lander starts after an accept never waits on the cadence (360988c63f), so no wake is queued.
assert.equal(wakes, 0);
assert.ok(observe(board => store.getItem(board, Number(item))).item_merged_commit, 'the second acceptance lands at once, inside the cadence');

}
