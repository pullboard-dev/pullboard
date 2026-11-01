import { submitHandoffHookActor } from '../submit-handoff-origin.js';
import { waivedLandingProof as nativeWaivedLandingProof } from '../landing-waivers.js';
import { quarantineWaivers } from '../quarantine.js';
/** The pullboard hook command, in its own module so an item adding another command never edits these lines. */
import { boardBusyError } from '../../packages/store/index.js';
import { openBoardReadOnly } from '../../packages/store/index.js';
import { rowDecisions } from '../../packages/spec/index.js';
import { checkLoosening } from '../../packages/doctrine/index.js';
import { runnerExecutionServices } from '../runners.js';
import { landingExecutionServices } from '../landing-shards.js';

const approvedRowPorts = { boardBusyError, openBoardReadOnly, rowDecisions, checkLoosening };
import { gitBoardDataPush } from '../../packages/commits/src/core/board-format.js';
import * as store from '../board.js';
import { pendingCommitSignoffProblem } from '../../packages/commits/index.js';
import { prepareCommitMetadata } from '../../packages/commits/index.js';
import { landingBatchOwnsRoot } from '../landing-candidates.js';
import { landingRows } from '../../packages/commits/src/core/landing-rows.js';
import {
  hookRead,
  readStdin,
} from '../cli-support.js';
import {
  gateWaitReporter,
} from '../gate-wait.js';
import {
  gateReport,
  runGate,
} from '../gate.js';
import {
  headTree,
  headCommit,
  tryGit,
  isClean,
  repoInfo,
  untracked,
  gitPath,
} from '../git.js';
import {
  applyFixers,
  commitCitationWarnings,
  commitMsgProblems,
  FIX_NOTE,
  preCommitProblems,
  prePushProblems,
  pushesTrunk,
} from '../../packages/commits/index.js';
import {
  Refused,
} from '../../packages/kernel/index.js';
import {
  withRowDrafts,
} from '../../packages/spec/index.js';
import {
  loadSpec,
} from '../../packages/spec/index.js';
import {
  trunkRef,
} from '../../packages/sandbox/index.js';
import {
  readFileSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import {
  context,
  resourceAgent,
  withBoard,
} from '../cli.js';

/**
 * The hooks git runs. In a repo without pullboard.json they pass, so a stray hook never blocks.
 *
 * @param {any} io
 * @param {any} args
 * @returns {Promise<number>}
 */
export async function hookCommand(io, { first, second }) {
  const info = repoInfo(io.cwd);
  let ctx;
  try {
    ctx = context(io);
  } catch (error) {
    if (error instanceof Refused && error.code === 'NO_CONFIG') return 0;
    throw error;
  }
  let problems = [];
  if (first === 'pre-commit' || first === 'pre-merge-commit') {
    applyFixers(info.root, ctx.config.fix).forEach((note) => io.err(`pullboard pre-commit: ${note}`));
    const agent = info.isMain ? null : hookRead(ctx, (board) => store.agentAt(board, info.root)
      ?? (first === 'pre-merge-commit' ? submitHandoffHookActor(ctx, board) : null));
    const landing = hookRead(ctx, (board) => store.landingBatches(board).some((batch) => landingBatchOwnsRoot(batch, info.root)));
    if (landing) io.caller('coordinator', info.root);
    else if (agent) io.caller('seat', info.root);
    problems = preCommitProblems({ approvedRowPorts, root: info.root, isMain: info.isMain || landing, config: ctx.config, agent, boardFile: ctx.file, preMergeHook: first === 'pre-merge-commit', onNotice: (message) => io.err(`pullboard pre-commit: warning: ${message}`) });
  } else if (first === 'commit-msg') {
    const originalMessage = readFileSync(second ?? '', 'utf8');
    const metadataContext = hookRead(ctx, board => {
      const agent = store.agentAt(board, info.root);
      const items = store.listItems(board, { all: true });
      const landing = info.isMain || store.landingBatches(board).some(batch => landingBatchOwnsRoot(batch, info.root));
      return {
        migration: landing && existsSync(gitPath(info.root, 'MERGE_HEAD'))
          ? { base: headCommit(info.root), side: tryGit(info.root, ['rev-parse', '--verify', 'MERGE_HEAD']).stdout } : null,
        claims: items.filter(item => item.item_status === 'claimed' && item.item_owner === agent?.agent_id),
        landings: landing ? items.filter(item => item.item_status === 'verified' && !item.item_merged_commit) : [],
      };
    }) ?? {};
    const spec = withRowDrafts(loadSpec(info.root, ctx.config), hookRead(ctx, (board) => store.rowDrafts(board)));
    const prepared = prepareCommitMetadata(originalMessage, { ...metadataContext, spec, syncMerge: existsSync(gitPath(info.root, 'MERGE_HEAD')) });
    const message = prepared.message;
    const signoff = pendingCommitSignoffProblem(info.root, message);
    if (signoff) { io.err(signoff); return 1; }
    commitCitationWarnings(message, { spec, doctrine: ctx.doctrine })
      .forEach((warning) => io.say(`pullboard commit-msg: warning: ${warning}`));
    const claimedItems = spec.rows.some(row => row.status === 'approved') ? [] : (hookRead(ctx, board => {
      const agent = store.agentAt(board, info.root);
      return agent ? store.listItems(board, { lane: agent.agent_lane }).filter(item =>
        item.item_status === 'claimed' && item.item_owner === agent.agent_id).map(item => item.item_id) : [];
    }) ?? []);
    // Only the main checkout or a landing worktree merges a verified item; elsewhere no trailer exempts a header.
    const rowlessLandings = hookRead(ctx, (board) => (info.isMain || store.landingBatches(board).some((batch) => landingBatchOwnsRoot(batch, info.root))
      ? store.listItems(board, { all: true }).filter((item) => item.item_status === 'verified' && !item.item_merged_commit && !landingRows(item).length).map((item) => item.item_id)
      : [])) ?? [];
    problems = [...prepared.problems, ...commitMsgProblems(message, { rules: ctx.config.commits, spec, doctrine: ctx.doctrine, claimedItems, rowlessLandings })];
    if (!problems.length && message !== originalMessage) writeFileSync(second, message);
  } else if (first === 'pre-push') {
    const refsText = await readStdin(io.stdin);
    if (gitBoardDataPush(info.root, refsText)) {
      io.say('pre-push: validated append-only board data; no code refs are updated');
      return 0;
    }
    problems = prePushProblems(info.root, refsText);
    if (!problems.length) {
      const landing = pushesTrunk(refsText, trunkRef(info.root));
      const waived = landing && withBoard(ctx, (board) => nativeWaivedLandingProof(board, headTree(info.root), { quarantineWaivers }));
      const recordedException = landing && withBoard(ctx, (board) => store.landingBatches(board).some((batch) => batch.proof?.tree === headTree(info.root) && batch.proof.failures?.length));
      if (waived && isClean(info.root) && !untracked(info.root).length) io.say(`pre-push: exact landing tree covered by live person waivers in batch ${waived.id}; no ordinary green stamp`);
      else if (recordedException) problems = ['the landing proof has an expired or missing person waiver; ask the person for a new expiring waiver'];
      else {
        const gate = await runGate(info.root, ctx.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, landing, agent: resourceAgent(ctx), onWait: gateWaitReporter(io) });
        if (gate.isCached) io.say('pre-push: the gate passed on this exact tree; not running it twice');
        if (!gate.isGreen) problems = [`the gate is red; fix it before pushing. ${gateReport(gate)}`];
      }
    }
  } else {
    throw new Refused('USAGE', 'pullboard hook pre-commit | pre-merge-commit | commit-msg <file> | pre-push');
  }
  if (!problems.length) return 0;
  io.err(`pullboard ${first}: blocked\n${problems.map((problem) => `  - ${io.guidance(problem)}`).join('\n')}\n${FIX_NOTE}`);
  return 1;
}

/** Run `pullboard hook` and return its exit code. */
export async function run(io, args) {
  return await hookCommand(io, args);
}
