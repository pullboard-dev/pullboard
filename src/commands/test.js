/** The pullboard test command, in its own module so an item adding another command never edits these lines. */
import { runnerExecutionServices } from '../runners.js';
import { landingExecutionServices } from '../landing-shards.js';
import { mainFailureNotices } from '../main-red.js';
import { listItems } from '../board-query.js';
import { compareMainFailures } from '../main-red.js';
import { withMainCheckout } from '../main-red.js';
import { runTestFiles } from '../test-run.js';
import { itemsInStatus } from '../board-query.js';
import {
  context,
  gateWaitReporter,
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
  const result = await runTestFiles(ctx.info.root, ctx.config, files, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, compareMainFailures, withMainCheckout, affected: values.affected === true, agent, item, onWait: gateWaitReporter(io) });
  result.mainFailures = mainFailureNotices(ctx.info.root, result.failureCases, result.mainComparison,
    { items: withBoardRead(ctx, board => listItems(board, { all: true })), exclude: item });
  delete result.failureCases;
  delete result.mainComparison;
  for (const notice of result.mainFailures) io.say(notice.message);
  io.result?.(result);
  if (!values.json && result.output) io.say(result.output.trimEnd());
  io.err(`pullboard test: ${result.green ? 'green' : 'red'} on ${result.runner} in ${result.seconds}s${result.local ? `: ${result.local}` : ''}`);
  if (result.mainUnavailable) io.err(`main comparison unavailable: ${result.mainUnavailable}`);
  return result.green ? 0 : 1;
}
