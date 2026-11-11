import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../../../packages/kernel/light.js';
import { queuesTestRun } from '../../../../../packages/drive/index.js';
import { queueTestRun } from '../../../../../packages/drive/index.js';
import { readTestRun } from '../../../../../packages/drive/index.js';
import { testRunLines } from '../../../../../packages/drive/index.js';
import { workTestRun } from '../../../../../packages/drive/index.js';
import { context } from '../context.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';

/** Capture only the seat's sole live build claim; ambiguous or absent ownership grants no item priority. */
async function claimedItem(ctx, agent) {
  const { itemsInStatus } = await import('../../../../../packages/store/index.js');
  return withBoardRead(ctx, board => {
    const claims = itemsInStatus(board, 'claimed', agent);
    return claims.length === 1 ? claims[0].item_id : undefined;
  });
}

/**
 * Run `pullboard test <files>` and return its exit code. An agent seat's call queues the run on the board and returns
 * at once with its run id; `pullboard next` hands the result back. With `--wait`, or for a person or a script, the
 * run happens here and blocks: 0 when every named file passes. `--status <id>` prints one run's state once.
 *
 * Why queue for seats: seats sat 16-54 min in sleep-and-pgrep loops on runner-queued runs; waiting is an error [C7].
 */
export async function run(io, { first, second, rest, values }) {
  const ctx = context(io);
  if (values.status !== undefined) return sayTestRunStatus(io, ctx, values.status);
  const files = [first, second, ...rest].filter((file) => file !== undefined && file !== '');
  if (values.diagnose === true && (files.length !== 1 || values.affected === true)) throw new Refused('USAGE', '--diagnose requires exactly one named test file');
  const seat = (await import('../board/access.js')).resourceAgent(ctx);
  const agent = seat ?? `pid-${process.pid}`;
  const item = await claimedItem(ctx, agent);
  if (values.diagnose !== true && queuesTestRun(ctx, seat, values)) return queueSeatRun(io, ctx, { agent, item, files, values });
  if (values['test-run'] !== undefined) {
    const { heartbeatSeat } = await import('../../../../../packages/store/index.js');
    await workTestRun(work => withBoard(ctx, work), values['test-run'], async () => (await (await import('../test/here.js')).runHere(io, ctx, { agent, item, files, values })).payload,
      { beatSeat: board => heartbeatSeat(board, agent) });
    return 0;
  }
  return (await (await import('../test/here.js')).runHere(io, ctx, { agent, item, files, values })).code;
}

/**
 * Queue a seat's run as a board-held job and print its one line. Refuses at once what the worker would refuse
 * later (no files, a missing file, no test runner), so a seat never learns of a typo through next.
 */
function queueSeatRun(io, ctx, { agent, item, files, values }) {
  const affected = values.affected === true;
  if (affected && files.length) throw new Refused('USAGE', 'use pullboard test --affected without file arguments, or name the files without --affected');
  if (!affected && !files.length) throw new Refused('USAGE', 'name the test files to run: pullboard test <file> [more files]');
  const missing = files.filter(file => !existsSync(join(ctx.info.root, file)));
  if (missing.length) throw new Refused('NO_TEST_FILE', `no such test file in this checkout: ${missing.join(', ')}`);
  if (!affected && (typeof ctx.config.affectedTests !== 'string' || !ctx.config.affectedTests.trim())) {
    throw new Refused('NO_TEST_RUNNER', 'set "affectedTests" in pullboard.json to the command that runs named test files, like "node apps/cli/src/io/run/tests.js"');
  }
  const queued = queueTestRun(ctx, work => withBoard(ctx, work), { agent, item, files, affected, compareMain: values['compare-main'] === true });
  io.result?.({ queued: true, run: queued.id, status: queued.status, files: queued.files, log: queued.log });
  io.say(`queued test run ${queued.id}; the board runs it and pullboard next brings the result; take your next item now: pullboard next --take`);
  return 0;
}

/** Print one queued run's state once, without waiting: `pullboard test --status <id>`. */
function sayTestRunStatus(io, ctx, id) {
  if (typeof id !== 'string' || !id.trim()) throw new Refused('USAGE', 'pass the run id: pullboard test --status <run id>');
  const found = withBoardRead(ctx, board => readTestRun(board, id.trim()));
  io.result?.(found);
  if (found.status === 'queued' || found.status === 'running') io.say(`test run ${found.id} ${found.status}: ${found.files.join(' ') || '--affected'}; pullboard next brings the result`);
  else for (const line of testRunLines(found)) io.say(line);
  return ['red', 'lost', 'refused'].includes(found.status) ? 1 : 0;
}
