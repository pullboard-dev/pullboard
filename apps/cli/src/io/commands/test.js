import { failureSignatures } from '../../../../../packages/landing/index.js';
/** The pullboard test command, in its own module so an item adding another command never edits these lines. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { mainFailureNotices } from '../../../../../packages/landing/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { compareMainFailures } from '../../../../../packages/landing/index.js';
import { withMainCheckout } from '../../../../../packages/landing/index.js';
import { runTestFiles } from '../../../../../packages/gate/index.js';
import { itemsInStatus } from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { knownRedCheck } from '../test/known.js';
import { recordClauseTicks } from './submit.js';
import { queuesTestRun } from '../../../../../packages/drive/index.js';
import { queueTestRun } from '../../../../../packages/drive/index.js';
import { readTestRun } from '../../../../../packages/drive/index.js';
import { testRunLines } from '../../../../../packages/drive/index.js';
import { workTestRun } from '../../../../../packages/drive/index.js';
import {
  context,
  resourceAgent,
  withBoard,
  withBoardRead,
} from '../entry.js';

/** Capture only the seat's sole live build claim; ambiguous or absent ownership grants no item priority. */
function claimedItem(ctx, agent) {
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
  const seat = resourceAgent(ctx);
  const agent = seat ?? `pid-${process.pid}`;
  const item = claimedItem(ctx, agent);
  if (values.diagnose !== true && queuesTestRun(ctx, seat, values)) return queueSeatRun(io, ctx, { agent, item, files, values });
  if (values['test-run'] !== undefined) {
    await workTestRun(work => withBoard(ctx, work), values['test-run'], async () => (await runHere(io, ctx, { agent, item, files, values })).payload);
    return 0;
  }
  return (await runHere(io, ctx, { agent, item, files, values })).code;
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
    throw new Refused('NO_TEST_RUNNER', 'set "affectedTests" in pullboard.json to the command that runs named test files, like "node packages/gate/src/io/run/tests.js"');
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

/** Run the files here and block for the result: the person's, the script's and a queued run's worker path. */
async function runHere(io, ctx, { agent, item, files, values }) {
  const result = await runTestFiles(ctx.info.root, ctx.config, files, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, compareMainFailures, withMainCheckout, failureSignatures, affected: values.affected === true, compareMain: values['compare-main'] === true, diagnose: values.diagnose === true, knownRed: knownRedCheck(ctx.info.root, () => withBoardRead(ctx, board => listItems(board, { all: true }))), agent, item, onWait: io.gateWaitReporter(io), say: line => io.err(line) });
  if (values['compare-main'] === true && !result.green && !result.mainSkipped) io.err('pullboard test: waiting on the main comparison (--compare-main)');
  result.mainFailures = mainFailureNotices(ctx.info.root, result.failureCases, result.mainComparison,
    { items: withBoardRead(ctx, board => listItems(board, { all: true })), exclude: item });
  const covered = new Set(result.mainFailures.map(row => row.file));
  result.mainFileFailures = result.known.filter(row => !covered.has(row.file)).map(row => ({
    file: row.file, main: result.main, result: row.result,
    message: `file ${row.result === 'red' ? 'also fails on' : row.result === 'absent' ? 'is absent on' : 'passes on'} main at ${result.main}: ${row.file} (case comparison unavailable)`,
  }));
  delete result.failureCases;
  delete result.mainComparison;
  for (const notice of [...result.mainFailures, ...result.mainFileFailures]) io.say(notice.message);
  io.result?.(result);
  if (!values.json && result.output) io.say(result.output.trimEnd());
  if (result.green && item !== undefined) await recordClauseTicks(io, item, files);
  io.err(`pullboard test: ${result.green ? 'green' : 'red'} on ${result.runner} in ${result.seconds}s${result.local ? `: ${result.local}` : ''}`);
  if (result.mainSkipped) io.err(`main comparison skipped: ${result.mainSkipped}`);
  if (result.mainUnavailable) io.err(`main comparison unavailable: ${result.mainUnavailable}`);
  const notices = [...result.mainFailures, ...result.mainFileFailures].map(notice => notice.message);
  if (result.mainSkipped) notices.push(`main comparison skipped: ${result.mainSkipped}`);
  if (result.mainUnavailable) notices.push(`main comparison unavailable: ${result.mainUnavailable}`);
  const payload = { green: result.green, runner: result.runner, seconds: result.seconds, counts: result.counts ?? null,
    failures: result.failures ?? [], logPath: result.logPath ?? null, files: result.files, notices };
  return { code: result.green ? 0 : 1, payload };
}
