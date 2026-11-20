/** Helpers for `pullboard join` and `pullboard whoami`: session binding and model identity. Split from src/cli.js, which re-exports it [C7]. */
import { folderIdle } from './item/folder/idle.js';
import { agentSessionDigest } from '../../../../packages/person/index.js';
import { identifyCaller } from './identity.js';
import { gitSyncLinked } from '../../../../packages/store/index.js';
import { environmentAgent } from '../../../../packages/link/index.js';
import { unjoinedRefusal } from '../../../../packages/seats/index.js';
import * as store from '../../../../packages/store/index.js';
import { context } from './context.js';
import { idArg } from './context.js';
import { withBoard } from './context.js';
import { withBoardRead } from './context.js';
import { CHECKOUT_BOARD_ONLY } from './main.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { displayAgentName } from '../../../../packages/seats/index.js';
import { bindLocalSession } from '../../../../packages/seats/index.js';
import { HOOK_CHECKOUT_WAIT_MS } from '../../../../packages/seats/index.js';
import { localSessionMatches } from '../../../../packages/seats/index.js';
import { endedFolderSession } from '../../../../packages/seats/index.js';
import { adoptLocalSession } from '../../../../packages/seats/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { tryGit } from '../../../../packages/git/index.js';
import { seatAt } from './item/folder/identity.js';
import { itemFolderRenewalRefusal } from './item/folder/identity.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { relayLinked } from '../../../../packages/link/index.js';
import { realpathSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { sep } from 'node:path';
import { environmentAdapter } from '../../../../packages/env/index.js';

/** Whether a root is one of the private worktrees publish makes under .git/pullboard/publish for its push (GitHub #25). */
function isPublishWorktree(info) {
  try {
    const folder = realpathSync(joinPath(info.commonDir, 'pullboard', 'publish'));
    return realpathSync(info.root).startsWith(folder + sep);
  } catch { return false; }
}

/**
 * Bind this checkout to the session behind a write command, which the command line has already told apart from a
 * read. A person's takeover in a linked main checkout binds no session (#347).
 */
export async function bindWriteSession(io, positionals, values) {
  const [command, first] = positionals;
  const digest = agentSessionDigest();
  if (!digest) {
    if (command === 'takeover' && !(repoInfo(io.cwd).isMain && relayLinked(repoInfo(io.cwd).root))) throw new Refused('AGENT_SESSION', 'takeover belongs to an agent session; run pullboard takeover from the agent’s shell');
    return;
  }
  // relay off changes the machine's link and opt-out, never the checkout, so with relay.excludeByBoard on a main checkout
  // bound to another session still lets the person turn the relay off [C7,#9415].
  if (command === 'relay' && first === 'off' && repoInfo(io.cwd).isMain && loadMachineSettings().relay?.excludeByBoard === true) return;
  if (command === 'check') {
    // Acceptance follows its person-channel path; it does not renew a build claim.
    if (first === 'accept') return;
    const ctx = context(io);
    const renewsOwnClaim = withBoardRead(ctx, (board) => {
      const agentId = ctx.info.isMain ? COORDINATOR : seatAt(board, ctx.info.root)?.agent_id;
      const item = first ? store.getItem(board, idArg(first)) : store.listItems(board)
        .find((entry) => entry.item_status === 'claimed' && entry.item_owner === agentId && entry.item_parent_id === null);
      return Boolean(agentId && item?.item_status === 'claimed' && item.item_owner === agentId);
    });
    // A named peer's check remains read-only. An owned check can renew, so acquire checkout
    // authority before joining the gate queue, in the same order as submit and verify.
    if (!renewsOwnClaim) return;
  }
  const info = repoInfo(io.cwd);
  let agent = info.isMain ? COORDINATOR : null;
  if (!info.isMain) {
    const ctx = context(io);
    const ownsLandingRoot = command === 'hook' ? (await import('../../../../packages/landing/light.js')).landingBatchOwnsRoot : () => false;
    agent = withBoardRead(ctx, (board) => seatAt(board, info.root)?.agent_id
      ?? (command === 'hook' && (isPublishWorktree(info) || store.landingBatches(board).some((batch) => ownsLandingRoot(batch, info.root))) ? COORDINATOR : null));
    if (!agent && command !== 'join') throw withBoardRead(ctx, (board) =>
      (command === 'hook' ? itemFolderRenewalRefusal(board, info.root) : null)
      ?? unjoinedRefusal(info, store.listAgents(board), agentSessionDigest));
  }
  // Comparison observes immutable Git objects and records facts; it never owns the builder checkout.
  const boardOnly = ['shout', 'fact'].includes(command) ? command : command === 'verify' && values.compare ? 'fact' : null;
  if (boardOnly && localSessionMatches(info, { agent: agent ?? 'unjoined agent', digest })) {
    CHECKOUT_BOARD_ONLY.set(io, boardOnly);
    return;
  }
  // The commit hooks only read: a checkout already bound to this session needs no lease, so they never queue for a slot.
  if (command === 'hook' && ['pre-commit', 'commit-msg'].includes(first) && localSessionMatches(info, { agent: agent ?? 'unjoined agent', digest })) return;
  const lease = await bindLocalSession(info, { agent: agent ?? 'unjoined agent', digest, takeover: command === 'takeover', keepLease: !['run', 'next', 'land'].includes(command), waitLimitMs: command === 'hook' ? HOOK_CHECKOUT_WAIT_MS : 0,
    /** Record the takeover; a linked main checkout takes the board's coordinator before its receipt shout, which the hold would refuse (#347). */
    recordTakeover: async () => (await import('./commands/takeover.js')).recordCheckoutTakeover(io, info),
  });
  if (agent) return { lease };
  /** Replace the temporary identity after a successful first join, retaining the winning session. */
  return { lease, finish: async () => {
    const ctx = context(io);
    const me = withBoard(ctx, (board) => whoAmI(ctx, board));
    lease.updateAgent(me.id);
  } };
}

/**
 * The ended session an item folder is bound to, or null when the claiming session has nothing to take over. Refuses
 * ITEM_FOLDER_SESSION_LIVE, naming the seat, when another live session still holds the folder (#3679).
 *
 * @param {any} board
 * @param {{ id: string }} me the claiming seat
 * @param {string} folder the item folder about to be adopted
 * @returns {{ digest: string, binding: { agent: string, digest: string } } | null}
 */
export function endedItemFolderSession(board, me, folder) {
  const digest = agentSessionDigest();
  if (!digest || !board) return null;
  const binding = endedFolderSession(repoInfo(folder), { agent: me.id, digest,
    liveSeats: () => store.listAgents(board).filter(seat => seat.presence === 'live'),
    idle: () => folderIdle(board, me, folder, tryGit) });
  return binding ? { digest, binding } : null;
}

/**
 * Bind an adopted item folder to the claiming session so its commit hooks accept the claimer's commits (#3679).
 * Why: the folder kept the ended seat's binding, and every commit there was refused NOT_YOUR_CHECKOUT.
 *
 * @param {string} folder the adopted item folder, at its new path
 * @param {{ id: string }} me the claiming seat
 * @param {{ digest: string, binding: { agent: string, digest: string } } | null} prior what endedItemFolderSession returned
 */
export async function adoptItemFolderSession(folder, me, prior) {
  if (prior) await adoptLocalSession(repoInfo(folder), { agent: me.id, digest: prior.digest, from: prior.binding });
}

/** Choose an explicitly supplied model or the standard environment fallback, refusing an unknown identity. */
export function requiredModel(value, env = environmentAdapter().all(), commandNext) {
  const model = (value ?? env.PULLBOARD_MODEL ?? '').trim();
  if (!model || /[\u0000-\u001f\u007f-\u009f]/u.test(model)) {
    const suffix = commandNext ? `; run pullboard ${commandNext} --model "<model name>"` : '';
    const message = commandNext
      ? `this session has not declared its model${suffix}`
      : 'give --model "<model name>" or set PULLBOARD_MODEL in this shell before joining';
    throw new Refused('MODEL_REQUIRED', message);
  }
  return model;
}

/** Resolve an optional coordinator declaration while preserving the legacy unknown identity. */
export function optionalModel(value, env = environmentAdapter().all()) {
  if (value === undefined && !env.PULLBOARD_MODEL) return undefined;
  return requiredModel(value, env);
}

/** Refuse to redeclare a coordinator whose linked board belongs to another checkout. */
export function refuseRemoteCoordinatorModel(ctx, command) {
  const coordinator = withBoard(ctx, (board) => store.listAgents(board).find((agent) => agent.agent_id === COORDINATOR));
  if (!coordinator) throw new Refused('NO_AGENT', 'the linked snapshot has no coordinator; restore a consistent relay snapshot before initializing');
  if (ctx.info.isMain && coordinator.agent_path === ctx.info.root) return;
  const name = displayAgentName(coordinator, ctx.config.agents.names);
  throw new Refused('REMOTE_COORDINATOR_MODEL', `the coordinator's model is declared on the coordinator's own checkout (${name}); run pullboard ${command} there`);
}

/** Resolve the caller with the existing environment and relay identity checks. */
export function whoAmI(ctx, board) {
  return identifyCaller(ctx, board, { environmentAgent, relayLinked: root => relayLinked(root) || gitSyncLinked(root) });
}

