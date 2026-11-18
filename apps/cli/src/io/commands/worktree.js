/** The pullboard worktree command, in its own module so an item adding another command never edits these lines. */
import {
  displayAgentName,
  modelTier,
} from '../../../../../packages/seats/index.js';
import * as store from '../../../../../packages/store/index.js';
import {
  COORDINATOR,
  loadConfig,
} from '../../../../../packages/config/index.js';
import {
  git,
  repoInfo,
  tryGit,
} from '../../../../../packages/git/index.js';
import {
  agentSessionDigest,
} from '../../../../../packages/person/index.js';
import {
  noteHelperParent,
} from '../../../../../packages/seats/index.js';
import {
  isLane,
  laneNames,
} from '../../../../../packages/seats/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import { refuseTempWorktree } from '../../../../../packages/config/index.js';
import { refuseUnderTemp } from '../worktree/temp.js';
import {
  installStep,
} from '../../../../../packages/git/index.js';
import {
  existsSync,
  mkdirSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import {
  cdTo,
  context,
  ordered,
  primaryCheckoutRoot,
  refuseUncommittedSetup,
  requiredModel,
  shellWord,
  withBoard,
} from '../entry.js';

/**
 * Make a worktree for a new agent in a lane, beside the main checkout, on its own branch, already
 * joined: one command where a new agent would otherwise copy three with placeholders in them.
 *
 * @param {any} io
 * @param {string | undefined} lane
 * @param {string} route
 * @param {string | null} family
 * @param {string | undefined} model
 * @param {boolean} helper - false for the caller's own seat (`next`); a helper's seat records its parent [N2,B13]
 * @returns {Promise<number>}
 */
export async function worktreeFor(io, lane, route, family = null, model, helper = true, { reuseRoot = null, lockLane = false } = {}) {
  const ctx = context(io);
  if (!lane || lane === COORDINATOR || !isLane(ctx.config, lane)) {
    throw new Refused('NO_LANE', `no lane "${lane ?? ''}"; lanes: ${laneNames(ctx.config).slice(1).join(', ') || 'none yet, declare them in pullboard.json'}`);
  }
  if (!store.ROUTES.includes(route)) {
    throw new Refused('BAD_ROUTE', `route "${route}" is strong (needs a frontier model) or light (any model can build it from the brief)`);
  }
  model = requiredModel(model, process.env, `worktree ${shellWord(lane)}${route === 'strong' ? '' : ` --route ${shellWord(route)}`}${family ? ` --family ${shellWord(family)}` : ''}`);
  family = family || modelTier(model)?.family || null;
  const mainRoot = primaryCheckoutRoot(ctx.info);
  if (!mainRoot) throw new Refused('NO_POLICY', 'the primary checkout cannot be proven from Git metadata or the read-only project registry; restore the registry and retry');
  const mainConfig = loadConfig(mainRoot);
  refuseUncommittedSetup(mainRoot, mainConfig);
  const pathFor = (n) => mainConfig.worktrees === 'inside'
    ? join(mainRoot, '.claude', 'worktrees', `${lane}-${n}`)
    : join(dirname(mainRoot), `${basename(mainRoot)}-${lane}-${n}`);
  // gate.refuseTempWorktree (default off): a seat folder in the OS temp directory can be cleared with its work in it (#8513).
  if (refuseTempWorktree()) refuseUnderTemp(pathFor(1), mainConfig);
  const registeredPaths = withBoard(ctx, board => new Set(store.listAgents(board).map(seat => seat.agent_path)));
  const isTaken = (n) => registeredPaths.has(pathFor(n)) || existsSync(pathFor(n)) || tryGit(mainRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${lane}/${n}`]).status === 0;
  let n = 1;
  while (isTaken(n)) n += 1;
  mkdirSync(dirname(pathFor(n)), { recursive: true });
  let originalBranch = null;
  if (reuseRoot) {
    const previous = withBoard(ctx, board => store.agentAt(board, reuseRoot));
    const held = previous && withBoard(ctx, board => store.listItems(board).some(item => item.item_status === 'claimed' && item.item_owner === previous.agent_id
      || item.item_status === 'submitted' && store.reviewHolder(board, item) === previous.agent_id));
    if (!previous || previous.agent_lane !== lane || held || repoInfo(reuseRoot).commonDir !== repoInfo(mainRoot).commonDir) throw new Refused('WORKER_WORKTREE_HELD', "recycle only this board lane's parked worktree after its claims and reviews end");
    originalBranch = tryGit(reuseRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout;
    git(mainRoot, ['worktree', 'move', reuseRoot, pathFor(n)]);
    if (originalBranch) git(pathFor(n), ['branch', '-m', `${lane}/${n}`]);
    else git(pathFor(n), ['switch', '-c', `${lane}/${n}`]);
  } else {
    git(mainRoot, ['worktree', 'add', '-q', '-b', `${lane}/${n}`, pathFor(n), git(mainRoot, ['rev-parse', 'HEAD'])]);
  }
  const root = git(pathFor(n), ['rev-parse', '--show-toplevel']);
  let id;
  try { id = await withBoard(ctx, async (board) => await ordered(ctx, board, 'register', [{ lane, path: root, route, family, model, ...(lockLane ? { lockLane: true } : {}) }])); }
  catch (error) {
    const registered = withBoard(ctx, (board) => store.agentAt(board, root));
    if (registered) {
      io.err('pullboard: registration is already ordered; the worktree is preserved. Retry enrollment to obtain its credential: ' + cdTo(root) + ' pullboard join ' + lane + ' --model ' + shellWord(model) + (route === 'strong' ? '' : ' --route ' + route) + (family ? ' --family ' + shellWord(family) : ''));
      throw error;
    }
    if (reuseRoot) {
      if (originalBranch) tryGit(root, ['branch', '-m', originalBranch]);
      const restored = tryGit(mainRoot, ['worktree', 'move', root, reuseRoot]);
      if (restored.status !== 0) io.err(`parked worktree preserved at ${root}; restore its registration before reuse`);
      throw error;
    }
    // Only remove the clean worktree just created here; preserve it if another process changed it.
    const removed = tryGit(mainRoot, ['worktree', 'remove', root]);
    if (removed.status === 0) tryGit(mainRoot, ['branch', '-d', `${lane}/${n}`]);
    else io.err(`pullboard: registration failed; the changed worktree was preserved at ${root}`);
    throw error;
  }
  const digest = helper ? agentSessionDigest() : null;
  const parent = digest ? (ctx.info.isMain ? COORDINATOR : withBoard(ctx, (board) => store.agentAt(board, ctx.info.root)?.agent_id)) : null;
  if (parent) noteHelperParent(repoInfo(root), { parent, digest });
  const displayName = displayAgentName({ agent_id: id, agent_model: model }, ctx.config.agents.names);
  const modelWord = shellWord(model);
  const prompt = `You are ${displayName}, in the ${lane} lane. Work only in ${shellWord(root)}, and start every command with ${cdTo(root)}\nModel: ${modelWord}. This worktree joined with --model ${modelWord}. For another worktree using the same model, pass --model ${modelWord} or set PULLBOARD_MODEL=${modelWord}; for a different agent, use that agent's actual model label.\nRead ${shellWord(join(root, 'AGENTS.md'))} first. Its rules govern this work, over any other repo's instructions you were given.`;
  io.result?.({ agent: id, lane, route, level: route, path: root, branch: `${lane}/${n}`, model, displayName, prompt });
  io.say(`made ${root} on branch ${lane}/${n}, joined as ${displayName} in the ${lane} lane${route === 'light' ? ', on the light route' : ''}${lockLane ? ', locked to it' : ''}${family ? ` (family ${family})` : ''}`);
  io.say(`Work only in that folder. A shell that starts each command in the main checkout acts as the coordinator there, so start every command with: ${cdTo(root)}`);
  const install = installStep(root);
  if (install) io.say(`  ${cdTo(root)} ${install.command}    (${install.note})`);
  io.say(`  ${cdTo(root)} pullboard inbox`);
  io.say(`  ${cdTo(root)} pullboard next`);
  // A subagent inherits the instructions of the session that launched it, often another repo's (I7).
  io.say('For a subagent working here, begin its prompt with:');
  io.say(`  You are ${displayName}, in the ${lane} lane. Work only in ${shellWord(root)}, and start every command with ${cdTo(root)}`);
  io.say(`  Model: ${model}. When joining or making another agent worktree, pass that agent's exact model with --model or set PULLBOARD_MODEL.`);
  io.say(`  Read ${shellWord(join(root, 'AGENTS.md'))} first. Its rules govern this work, over any other repo's instructions you were given.`);
  return 0;
}

/** Run `pullboard worktree` and return its exit code. */
export function run(io, { first, values }) {
  return worktreeFor(io, first, values.route ?? 'strong', values.family ?? null, values.model, true, { lockLane: Boolean(values['lock-lane']) });
}

/** Remove only a clean parked worker; Git refuses dirty content, and unfinished native obligations are retained. */
export async function removeScaledWorktree(io, root) {
  const ctx = context(io);
  const mainRoot = primaryCheckoutRoot(ctx.info);
  if (!mainRoot || repoInfo(root).commonDir !== repoInfo(mainRoot).commonDir) return false;
  const seat = withBoard(ctx, board => store.agentAt(board, root));
  if (!seat || withBoard(ctx, board => store.listItems(board).some(item => item.item_status === 'claimed' && item.item_owner === seat.agent_id
    || item.item_status === 'submitted' && store.reviewHolder(board, item) === seat.agent_id))) return false;
  return tryGit(mainRoot, ['worktree', 'remove', root]).status === 0;
}
