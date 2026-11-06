import { failureSignatures } from '../../../../../packages/landing/index.js';
/** The pullboard test command, in its own module so an item adding another command never edits these lines. */
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { mainFailureNotices } from '../../../../../packages/landing/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { compareMainFailures } from '../../../../../packages/landing/index.js';
import { withMainCheckout } from '../../../../../packages/landing/index.js';
import { runTestFiles } from '../../../../../packages/gate/index.js';
import { itemsInStatus } from '../../../../../packages/store/index.js';
import {
  context,
  resourceAgent,
  withBoardRead,
} from '../cli.js';

/** Capture only the seat's sole live build claim; ambiguous or absent ownership grants no item priority. */
function claimedItem(ctx, agent) {
  return withBoardRead(ctx, board => {
    const claims = itemsInStatus(board, 'claimed', agent);
    return claims.length === 1 ? claims[0].item_id : undefined;
  });
}

/** Run `pullboard test <files>` and return its exit code: 0 when every named file passes. */
export async function run(io, { first, second, rest, values }) {
  const ctx = context(io);
  const files = [first, second, ...rest].filter((file) => file !== undefined && file !== '');
  const agent = resourceAgent(ctx) ?? `pid-${process.pid}`;
  const item = claimedItem(ctx, agent);
  const result = await runTestFiles(ctx.info.root, ctx.config, files, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, compareMainFailures, withMainCheckout, failureSignatures, affected: values.affected === true, compareMain: values['compare-main'] === true, agent, item, onWait: io.gateWaitReporter(io) });
  if (values['compare-main'] === true && !result.green) io.err('pullboard test: waiting on the main comparison (--compare-main)');
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
  io.err(`pullboard test: ${result.green ? 'green' : 'red'} on ${result.runner} in ${result.seconds}s${result.local ? `: ${result.local}` : ''}`);
  if (result.mainSkipped) io.err(`main comparison skipped: ${result.mainSkipped}`);
  if (result.mainUnavailable) io.err(`main comparison unavailable: ${result.mainUnavailable}`);
  return result.green ? 0 : 1;
}
