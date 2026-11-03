/** Helpers for `pullboard join` and `pullboard whoami`: session binding and model identity. Split from src/cli.js, which re-exports it [C7]. */
import { agentSessionDigest } from '../../../../../packages/person/index.js';
import { identifyCaller } from '../cli-identity.js';
import { gitSyncLinked } from '../../../../../packages/store/index.js';
import { environmentAgent } from '../../../../../packages/link/index.js';
import { unjoinedRefusal } from '../../../../../packages/seats/index.js';
import * as store from '../../../../../packages/store/index.js';
import { context } from '../cli-context.js';
import { idArg } from '../cli-context.js';
import { withBoard } from '../cli-context.js';
import { CHECKOUT_BOARD_ONLY } from '../cli-main.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { displayAgentName } from '../../../../../packages/seats/index.js';
import { bindLocalSession } from '../../../../../packages/seats/index.js';
import { HOOK_CHECKOUT_WAIT_MS } from '../../../../../packages/seats/index.js';
import { localSessionMatches } from '../../../../../packages/seats/index.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { seatAt } from '../item-folder-identity.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { relayLinked } from '../../../../../packages/link/index.js';

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
  if (command === 'check') {
    // Acceptance follows its person-channel path; it does not renew a build claim.
    if (first === 'accept') return;
    const ctx = context(io);
    const renewsOwnClaim = withBoard(ctx, (board) => {
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
    const ownsLandingRoot = command === 'hook' ? (await import('../../../../../packages/landing/index.js')).landingBatchOwnsRoot : () => false;
    agent = withBoard(ctx, (board) => seatAt(board, info.root)?.agent_id
      ?? (command === 'hook' && store.landingBatches(board).some((batch) => ownsLandingRoot(batch, info.root)) ? COORDINATOR : null));
    if (!agent && command !== 'join') throw withBoard(ctx, (board) => unjoinedRefusal(info, store.listAgents(board), agentSessionDigest));
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
    recordTakeover: async () => (await import('../commands/takeover.js')).recordCheckoutTakeover(io, info),
  });
  if (agent) return { lease };
  /** Replace the temporary identity after a successful first join, retaining the winning session. */
  return { lease, finish: async () => {
    const ctx = context(io);
    const me = withBoard(ctx, (board) => whoAmI(ctx, board));
    lease.updateAgent(me.id);
  } };
}

/** Choose an explicitly supplied model or the standard environment fallback, refusing an unknown identity. */
export function requiredModel(value, env = process.env, commandNext) {
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
export function optionalModel(value, env = process.env) {
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

