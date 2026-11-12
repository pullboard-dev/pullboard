import { stagedShimImportProblems } from '../../../../../packages/codemap/index.js';
import { importsIn } from '../../../../../packages/codemap/light.js';
import { itemFolderIdentity } from '../../../../../packages/items/index.js';
import { itemFolderPath } from '../../../../../packages/items/index.js';
import { submitHandoffHookActor } from '../../../../../packages/sandbox/index.js';
/**
 * Claims that may stamp trailers: the live ones, or the submitted item's own claim when only its gate handoff remains,
 * so a fix commit still cites the item while the gate runs [C7,#2882].
 *
 * @param {any[]} claims - This seat's claimed items.
 * @param {(item: any) => unknown} pending - Whether the item's submit handoff is queued or running.
 * @returns {any[]}
 */
export function submittedClaimsFallback(claims, pending) {
  const live = claims.filter(item => !pending(item));
  return live.length ? live : claims;
}

/** The pullboard hook command, in its own module so an item adding another command never edits these lines. */
import { busyRefusal } from '../../../../../packages/store/light.js';
import { openBoardReadOnly } from '../../../../../packages/store/light.js';
import { pendingSubmitHandoff } from '../../../../../packages/store/light.js';
import { readBoardSnapshot } from '../../../../../packages/store/light.js';
import { systemClock } from '../../../../../packages/store/light.js';
import { rowDecisions } from '../../../../../packages/spec/index.js';
import { checkLoosening } from '../../../../../packages/doctrine/index.js';

/** The thin hook entry reads its clock from here, so only this module names the store [H24]. */
export { systemClock as hookClock };
const hookRead = hookReader({ openBoardReadOnly, boardBusyError: busyRefusal, readBoardSnapshot });
/** The id of the seat committing at `root`, its own checkout or one of its item folders; null when none is. */
export function hookSeatId(ctx, root) {
  return hookRead(ctx, (board) => (store.agentAt(board, root) ?? itemFolderIdentity(board, root)?.agent)?.agent_id) ?? null;
}
const approvedRowPorts = { boardBusyError: busyRefusal, openBoardReadOnly, rowDecisions, checkLoosening };
import { gitBoardDataPush } from '../../../../../packages/commits/index.js';
import * as store from '../../../../../packages/store/light.js';
import { pendingCommitSignoffProblem } from '../../../../../packages/commits/index.js';
import { prepareCommitMetadata } from '../../../../../packages/commits/index.js';
import { landingBatchItemsAtRoot } from '../../../../../packages/landing/light.js';
import { landingBatchOwnsRoot } from '../../../../../packages/landing/light.js';
import { fixStagedImportBindings } from '../../../../../packages/commits/index.js';
import { landingRows } from '../../../../../packages/commits/index.js';
import { hookReader } from '../hook/read.js';
import { stagedStaticProblems } from '../hook/static.js';
import { readStdin } from '../hook/stdin.js';
import { checkedLandingCommit } from '../../../../../packages/verify/index.js';
import {
  landingBatches,
  headTree,
  headCommit,
  tryGit,
  withGitCommandMemo,
  checkoutBranch,
  checkoutRefCommit,
  isClean,
  repoInfo,
  untracked,
  gitPath,
} from '../../../../../packages/git/index.js';
import {
  applyFixers,
  commitCitationWarnings,
  commitMsgProblems,
  fixCommitHeader,
  FIX_NOTE,
  preCommitProblems,
  prePushProblems,
  pushesTrunk,
} from '../../../../../packages/commits/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  withRowDrafts,
} from '../../../../../packages/spec/index.js';
import {
  loadSpec,
} from '../../../../../packages/spec/index.js';
import {
  trunkRef,
} from '../../../../../packages/sandbox/light.js';
import {
  readFileSync,
  existsSync,
  writeFileSync,
} from 'node:fs';

/**
 * The hooks git runs. In a repo without pullboard.json they pass, so a stray hook never blocks.
 *
 * @param {any} io
 * @param {any} args
 * @returns {Promise<number>}
 */
/**
 * Refuse a commit of item work in a seat checkout, naming the item folder to use (#3691).
 * Why: builders committed on <lane>/item-<id> inside their seat checkout, which left the seat on an item branch and
 * blocked every other seat from that item with ITEM_FOLDER_PROTECTED. Item work belongs in the seat's item folder.
 *
 * @param {string} root the committing checkout
 * @param {{ agent_id: string, agent_path: string } | null | undefined} seat the seat whose own checkout this is, if any
 */
export function refuseSeatItemWork(root, seat) {
  if (!seat?.agent_path) return;
  const match = /^[^/]+\/item-([1-9]\d*)$/u.exec(checkoutBranch(root) ?? '');
  if (!match) return;
  const folder = itemFolderPath(seat.agent_path, Number(match[1]));
  throw new Refused('ITEM_WORK_IN_SEAT', `item work for #${match[1]} is committed in the seat checkout ${root}; item work is built in its item folder ${folder}`,
    `move the change to ${folder} (pullboard claim ${match[1]} opens it), commit there, and switch this seat checkout off the item branch`);
}

export async function hookCommand(io, { first, second }) {
  const info = repoInfo(io.cwd);
  let ctx;
  try {
    // The thin hook entry supplies a light context; the full CLI builds the ordinary one, loaded only then [H24].
    ctx = io.hookContext ? io.hookContext(io) : (await import('../entry.js')).context(io);
  } catch (error) {
    if (error instanceof Refused && error.code === 'NO_CONFIG') return 0;
    throw error;
  }
  let problems = [];
  if (first === 'pre-commit' || first === 'pre-merge-commit') {
    // A composed run's fixers already ran against the real index, so the checked bytes are the committed bytes (#2593).
    if (process.env.PULLBOARD_HOOK_COMPOSED !== '1') [...applyFixers(info.root, ctx.config.fix), ...fixStagedImportBindings(info.root)].forEach((note) => io.err(`pullboard pre-commit: ${note}`));
    if (process.env.PULLBOARD_HOOK_COMPOSED === 'fix') return 0;
    // A boardless clone with board.url set is a seat whose lane the served board names, never the coordinator [P7].
    const remoteSeat = existsSync(ctx.file) ? null : await (await import('../remote/board.js')).remoteHookSeat(info.root);
    const isMain = info.isMain && !remoteSeat;
    const agent = remoteSeat ?? (isMain ? null : hookRead(ctx, (board) => (store.agentAt(board, info.root) ?? itemFolderIdentity(board, info.root)?.agent)
      ?? (first === 'pre-merge-commit' ? submitHandoffHookActor(ctx, board) : null)));
    const landing = hookRead(ctx, (board) => landingBatches(board).some((batch) => landingBatchOwnsRoot(batch, info.root)));
    if (first === 'pre-commit' && !landing) refuseSeatItemWork(info.root, hookRead(ctx, (board) => store.agentAt(board, info.root)));
    if (landing) io.caller('coordinator', info.root);
    else if (agent) io.caller('seat', info.root);
    const criterion = agent ? hookRead(ctx, board => {
      const folderItem = itemFolderIdentity(board, info.root)?.item;
      const claims = store.listItems(board).filter(item => item.item_status === 'claimed'
        && item.item_owner === agent.agent_id && (folderItem === undefined || item.item_id === folderItem)
        && !pendingSubmitHandoff(board, item));
      return claims.length === 1 && claims[0].item_frozen ? JSON.parse(claims[0].item_frozen).criterion ?? '' : '';
    }) ?? '' : '';
    const trunk = trunkRef(info.root);
    // The trunk branch's commit comes from Git's ref files when they can answer, so no process is started for it.
    const accepted = (trunk?.startsWith('refs/heads/') ? checkoutRefCommit(info.root, trunk) : null) || tryGit(info.root, ['rev-parse', '--verify', trunk]).stdout.trim() || 'HEAD';
    const shimImports = options => stagedShimImportProblems({ ...options, accepted, parseImports: importsIn, criterion });
    const staticProblems = await stagedStaticProblems(info.root, process.env);
    problems = [...staticProblems, ...withGitCommandMemo(() => preCommitProblems({ shimImports, approvedRowPorts, root: info.root, isMain: isMain || landing, config: ctx.config, agent, boardFile: ctx.file, preMergeHook: first === 'pre-merge-commit', onNotice: (message) => io.err(`pullboard pre-commit: warning: ${message}`) }))];
  } else if (first === 'commit-msg') {
    const originalMessage = readFileSync(second ?? '', 'utf8');
    const metadataContext = hookRead(ctx, board => {
      const agent = (store.agentAt(board, info.root) ?? itemFolderIdentity(board, info.root)?.agent);
      const items = store.listItems(board, { all: true });
      const folderItem = itemFolderIdentity(board, info.root)?.item;
      const landing = info.isMain || landingBatches(board).some(batch => landingBatchOwnsRoot(batch, info.root));
      return {
        migration: landing && existsSync(gitPath(info.root, 'MERGE_HEAD'))
          ? { base: headCommit(info.root), side: tryGit(info.root, ['rev-parse', '--verify', 'MERGE_HEAD']).stdout } : null,
        claims: submittedClaimsFallback(items.filter(item => item.item_status === 'claimed' && item.item_owner === agent?.agent_id && (folderItem === undefined || item.item_id === folderItem)),
          item => pendingSubmitHandoff(board, item)),
        landings: info.isMain ? items.filter(item => item.item_status === 'verified' && !item.item_merged_commit)
          : landingBatchItemsAtRoot(landingBatches(board), info.root, items, item => checkedLandingCommit(board, item)),
      };
    }) ?? {};
    const spec = withRowDrafts(loadSpec(info.root, ctx.config), hookRead(ctx, (board) => store.rowDrafts(board)));
    const prepared = prepareCommitMetadata(originalMessage, { ...metadataContext, spec, syncMerge: existsSync(gitPath(info.root, 'MERGE_HEAD')) });
    // Mechanical header style is fixed here and said, never refused, so it costs no retry [C7,#5775].
    const styled = fixCommitHeader(prepared.message, ctx.config.commits);
    styled.notes.forEach((note) => io.err(`pullboard commit-msg: fixed: ${note}`));
    const message = styled.message;
    const signoff = pendingCommitSignoffProblem(info.root, message);
    if (signoff) { io.err(signoff); return 1; }
    commitCitationWarnings(message, { spec, doctrine: ctx.doctrine })
      .forEach((warning) => io.say(`pullboard commit-msg: warning: ${warning}`));
    const claimedItems = spec.rows.some(row => row.status === 'approved') ? [] : (hookRead(ctx, board => {
      const agent = (store.agentAt(board, info.root) ?? itemFolderIdentity(board, info.root)?.agent);
      return agent ? store.listItems(board, { lane: agent.agent_lane }).filter(item =>
        item.item_status === 'claimed' && item.item_owner === agent.agent_id && !pendingSubmitHandoff(board, item)).map(item => item.item_id) : [];
    }) ?? []);
    // Only the main checkout or a landing worktree merges a verified item; elsewhere no trailer exempts a header.
    const rowlessLandings = (metadataContext.landings ?? []).filter(item => !landingRows(item).length).map(item => item.item_id);
    problems = [...prepared.problems, ...commitMsgProblems(message, { rules: ctx.config.commits, spec, doctrine: ctx.doctrine, claimedItems, rowlessLandings })];
    if (!problems.length && message !== originalMessage) writeFileSync(second, message);
  } else if (first === 'pre-push') {
    const refsText = await readStdin(io.stdin);
    // Only a push runs the gate, so the gate, runner, landing and flake graphs load here and never for a commit hook [C7,#3250].
    const { resourceAgent, withBoard } = await import('../entry.js');
    const { gateReport, runGate } = await import('../../../../../packages/gate/index.js');
    const { runnerExecutionServices } = await import('../../../../../packages/runners/index.js');
    const { landingExecutionServices, waivedLandingProof: nativeWaivedLandingProof } = await import('../../../../../packages/landing/index.js');
    const { quarantineWaivers } = await import('../../../../../packages/flakes/index.js');
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
        const gate = await runGate(info.root, ctx.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, landing, agent: resourceAgent(ctx), onWait: io.gateWaitReporter(io) });
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
  // One memo for the whole hook run: the fixers and static checks ask Git the same read-only questions as the hook checks.
  return await withGitCommandMemo(() => hookCommand(io, args));
}
