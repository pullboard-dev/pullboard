/** The pre-push checks, loaded only by that hook so a commit hook never pays for the gate, push and landing graphs [C7,H24]. */
import { gitBoardDataPush } from '../../../../../packages/commits/index.js';
import {
  prePushProblems,
  pushesTrunk,
} from '../../../../../packages/commits/index.js';
import { trunkRef } from '../../../../../packages/sandbox/light.js';
import {
  landingBatches,
  headTree,
  isClean,
  untracked,
} from '../../../../../packages/git/index.js';
import { readStdin } from './stdin.js';

/**
 * Run the pre-push checks for one push.
 *
 * @param {any} io
 * @param {any} ctx hook context
 * @param {any} info the pushing checkout
 * @param {() => Promise<any>} loadGraphs loads the runner and flake graphs, named by the hook command
 * @returns {Promise<number | string[]>} an exit code when the hook ends early, else the problems found
 */
export async function prePushHook(io, ctx, info, loadGraphs) {
  let problems = [];
  const refsText = await readStdin(io.stdin);
  // Only a push runs the gate, so the gate, runner, landing and flake graphs load here and never for a commit hook [C7,#3250].
  const { resourceAgent, withBoard } = await import('../entry.js');
  const { gateReport, isStampedGreen, runGate } = await import('../../../../../packages/gate/index.js');
  const { runnerExecutionServices, landingExecutionServices, nativeWaivedLandingProof, quarantineWaivers } = await loadGraphs();
  if (gitBoardDataPush(info.root, refsText)) {
    io.say('pre-push: validated append-only board data; no code refs are updated');
    return 0;
  }
  problems = prePushProblems(info.root, refsText);
  if (!problems.length) {
    const landing = pushesTrunk(refsText, trunkRef(info.root));
    const waived = landing && withBoard(ctx, (board) => nativeWaivedLandingProof(board, headTree(info.root), { quarantineWaivers }));
    const recordedException = landing && withBoard(ctx, (board) => landingBatches(board).some((batch) => batch.proof?.tree === headTree(info.root) && batch.proof.failures?.length));
    // A batch whose every red case is red identically on its main base records a known-main proof for this tree (#2586).
    const knownMain = landing && withBoard(ctx, (board) => landingBatches(board).findLast((batch) => ['ready', 'pushed'].includes(batch.state)
      && batch.proof?.tree === headTree(info.root) && !batch.proof.failures?.length && batch.proof.knownMain?.length));
    if (waived && isClean(info.root) && !untracked(info.root).length) io.say(`pre-push: exact landing tree covered by live person waivers in batch ${waived.id}; no ordinary green stamp`);
    else if (knownMain && isClean(info.root) && !untracked(info.root).length) io.say(`pre-push: exact landing tree red only in cases red on main in batch ${knownMain.id}: ${knownMain.proof.knownMain.map((row) => `${row.file} :: ${row.name}`).join('; ')}`);
    else if (recordedException) problems = ['the landing proof has an expired or missing person waiver; ask the person for a new expiring waiver'];
    else {
      // The full gate's files run as pull shard jobs over every free runner, not as one command on one runner [C7,#7743].
      // A real push of main takes the same path, so every shard runs to its end and a red names every failing file [C7,#8043].
      const sharded = isStampedGreen(info.root) ? null : await (await import('../hook/push.js')).pushShardGate(ctx, { say: io.say });
      if (sharded && !sharded.isGreen) problems = [sharded.problem];
      const gate = sharded ? null : await runGate(info.root, ctx.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, landing, agent: resourceAgent(ctx), onWait: io.gateWaitReporter(io) });
      if (gate?.isCached) io.say('pre-push: the gate passed on this exact tree; not running it twice');
      if (gate && !gate.isGreen) problems = [`the gate is red; fix it before pushing. ${gateReport(gate)}`];
    }
  }  return problems;
}
