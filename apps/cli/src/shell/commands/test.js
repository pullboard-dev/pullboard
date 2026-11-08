import { failureSignatures } from '../../../../../packages/landing/index.js';
/** The pullboard test command, in its own module so an item adding another command never edits these lines. */
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { mainFailureNotices } from '../../../../../packages/landing/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { compareMainFailures } from '../../../../../packages/landing/index.js';
import { withMainCheckout } from '../../../../../packages/landing/index.js';
import { runTestFiles } from '../../../../../packages/gate/index.js';
import { itemsInStatus } from '../../../../../packages/store/index.js';
import { testRunTickNotes } from '../../../../../packages/state/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import {
  actOn,
  ordered,
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

/**
 * Tick the claimed item's test clauses after a green run of files inside its check, as ordinary note facts.
 * Why: submit reads those notes, so a green runner proof no longer ends in CLAUSE_UNTICKED [C7].
 */
async function recordClauseTicks(io, itemId, files, head) {
  await actOn(io, async (ctx, board, me) => {
    const found = getItem(board, itemId);
    if (found.item_owner !== me.id) return 0;
    for (const text of testRunTickNotes(found, files, head)) await ordered(ctx, board, 'appendFact', [itemId, { agentId: me.id, kind: 'note', text }]);
    return 0;
  });
}

/** Run `pullboard test <files>` and return its exit code: 0 when every named file passes. */
export async function run(io, { first, second, rest, values }) {
  const ctx = context(io);
  const files = [first, second, ...rest].filter((file) => file !== undefined && file !== '');
  const agent = resourceAgent(ctx) ?? `pid-${process.pid}`;
  const item = claimedItem(ctx, agent);
  const result = await runTestFiles(ctx.info.root, ctx.config, files, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, compareMainFailures, withMainCheckout, failureSignatures, affected: values.affected === true, compareMain: values['compare-main'] === true, agent, item, onWait: io.gateWaitReporter(io), say: line => io.err(line) });
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
  if (result.green && item !== undefined) await recordClauseTicks(io, item, files, headCommit(ctx.info.root));
  io.err(`pullboard test: ${result.green ? 'green' : 'red'} on ${result.runner} in ${result.seconds}s${result.local ? `: ${result.local}` : ''}`);
  if (result.mainSkipped) io.err(`main comparison skipped: ${result.mainSkipped}`);
  if (result.mainUnavailable) io.err(`main comparison unavailable: ${result.mainUnavailable}`);
  return result.green ? 0 : 1;
}
