/** Run named test files in this process and print what main says about each failure [C7]. */
import { failureSignatures } from '../../../../../packages/landing/index.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { mainFailureNotices } from '../../../../../packages/landing/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { compareMainFailures } from '../../../../../packages/landing/index.js';
import { withMainCheckout } from '../../../../../packages/landing/index.js';
import { runTestFiles } from '../../../../../packages/gate/index.js';
import { knownRedCheck } from './known.js';
import { updateMainReds } from './main-reds.js';
import { recordClauseTicks } from '../commands/submit.js';
import { withBoardRead } from '../context.js';
import { withBoard } from '../context.js';
import { actOn } from '../board/access.js';
import { resourceAgent } from '../board/access.js';
import { ordered } from '../claim.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { proofRunReceipt } from '../../../../../packages/store/index.js';
import { storeTestReceipt } from '../../../../../packages/store/index.js';
import { recordNativeProof } from '../../../../../packages/verify/index.js';

/**
 * Record a green run as a proof-run on each item the seat proves: the receipt names the item, the checkout's HEAD and the runner.
 * Why: a test run counts as proof only when pullboard show <id> can name the item and commit it covered [C7].
 */
export async function recordTestProofs(io, ctx, { items, files, result }) {
  const commit = headCommit(ctx.info.root);
  await actOn(io, async (actCtx, board, me) => {
    for (const id of items) {
      const found = getItem(board, id);
      if (found.item_owner !== me.id) continue;
      const proofReceiptId = storeTestReceipt(board, { agentId: me.id, itemId: id, commit, files, runner: result.runner ?? null,
        durationMs: Math.round((result.seconds ?? 0) * 1000), counts: result.counts ?? undefined });
      if (proofReceiptId) await recordNativeProof(actCtx, found, { proofReceiptId }, { ordered, withBoard, resourceAgent, proofRunReceipt, exitFailures: true }, board);
    }
    return 0;
  });
}

/** Run the files here and block for the result: the person's, the script's and a queued run's worker path. */
export async function runHere(io, ctx, { agent, item, items = [], files, values }) {
  const knownRed = knownRedCheck(ctx.info.root, () => withBoardRead(ctx, board => listItems(board, { all: true })));
  // Under pull dispatch, or for an item the pull pilot picks, the run is one runner job row: nothing is packed or sent from here [P7].
  const pulled = await import('./pull.js');
  const result = pulled.pullTestWanted(item, values)
    ? await pulled.runPulledTests(ctx, { agent, item, files, values, knownRed, say: line => io.err(line) })
    : await runTestFiles(ctx.info.root, ctx.config, files, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, compareMainFailures, withMainCheckout, failureSignatures, affected: values.affected === true, compareMain: values['compare-main'] === true, diagnose: values.diagnose === true, knownRed, agent, item, onWait: io.gateWaitReporter(io), say: line => io.err(line) });
  if (values['compare-main'] === true && !result.green && !result.mainSkipped && !result.pulled) io.err('pullboard test: waiting on the main comparison (--compare-main)');
  result.mainFailures = result.pulled ? result.pulledNotices : mainFailureNotices(ctx.info.root, result.failureCases, result.mainComparison,
    { items: withBoardRead(ctx, board => listItems(board, { all: true })), exclude: item });
  delete result.pulledNotices;
  const covered = new Set(result.mainFailures.map(row => row.file));
  result.mainFileFailures = result.known.filter(row => !covered.has(row.file)).map(row => ({
    file: row.file, main: result.main, result: row.result,
    message: `file ${row.result === 'red' ? 'also fails on' : row.result === 'absent' ? 'is absent on' : 'passes on'} main at ${result.main}: ${row.file} (case comparison unavailable)`,
  }));
  const cases = (result.failureCases ?? result.runFailures ?? []).filter(row => row?.file && row.name);
  const named = result.pulled ? result.runFailures != null : result.failureCases != null || result.green;
  delete result.failureCases;
  delete result.runFailures;
  delete result.mainComparison;
  for (const notice of [...result.mainFailures, ...result.mainFileFailures]) io.say(notice.message);
  io.result?.(result);
  if (!values.json && result.output) io.say(result.output.trimEnd());
  // A red run that names no cases proves nothing about which files failed, so it neither files nor closes.
  if (result.green || named) await updateMainReds(io, ctx, { green: result.green, files: result.files, cases });
  if (result.green && item !== undefined) await recordClauseTicks(io, item, files);
  if (result.green && !values.diagnose && items.length) await recordTestProofs(io, ctx, { items, files: result.files ?? files, result });
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
