import packageData from '../../../../../package.json' with { type: 'json' };
import { checkAtCommit } from '../../../../runner/index.js';
/** The pullboard doctor command, in its own module so an item adding another command never edits these lines. */
import {
  doctorProblems,
  doctrineProblems,
  reviewFamilyCover,
} from '../../../../../packages/health/index.js';
import { boardRemote } from '../../../../../packages/config/index.js';
import { roleHosts } from '../../../../../packages/config/index.js';
import { trunkRemote } from '../../../../../packages/config/index.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';
import { runsStoreOn } from '../../../../../packages/store/index.js';
import { reconcilerLine } from '../reconcile.js';
import { settleOnce } from '../reconcile.js';
import {
  bareWorktreeFinding,
  tryGit,
} from '../../../../../packages/git/index.js';
import {
  outdatedSender,
  outdatedSenderLine,
  unlinkedRelayProjects,
} from '../../../../../packages/link/index.js';
import {
  formatSnapshotLimit,
  pendingCheckpointProblem,
  pendingSnapshotSize,
} from '../../../../../packages/link/index.js';
import {
  skillProblems,
} from '../skills.js';
import {
  context,
} from '../entry.js';
import { agentHookStatus } from '../../../../../packages/seats/index.js';
import { runnerServiceProblems } from '../../../../../packages/runners/index.js';
import { spawnReachable } from '../../../../../packages/jobs/index.js';
import { unclaimedGateJobs } from '../../../../../packages/jobs/index.js';

/** The jobs cell's reachable launcher, for the resident client: it starts a daemon as a launchd job, as doctor expects every daemon to be [C7,#5760]. */
export { spawnReachable };
import { trunkUpdateInsteadProblem } from '../landing/checkout.js';
import { anyRunnerLive } from '../runner/local.js';
import { residentDaemons } from '../resident/daemons.js';
import { appDaemonProblems } from '../../logic/runner/daemons.js';
import { toolchainProblems } from '../../logic/runner/toolchains.js';
import { jestWorktreeProblem } from '../../logic/jest-worktrees.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMachineSettings } from '../../../../../packages/config/index.js';

/** The text of a file under `root`, or undefined when it is missing or unreadable. */
function textAt(root, name) {
  try { return existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : undefined; } catch { return undefined; }
}

/** The Jest finding for the project at `root`: its package.json and its Jest config file, or the package's jest key, read as text [C7,#11848]. */
function jestProblem(root) {
  const packageText = textAt(root, 'package.json');
  const file = ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts'].map(name => textAt(root, name)).find(Boolean);
  let inline;
  try { inline = JSON.stringify(JSON.parse(packageText ?? 'null')?.jest); } catch { inline = undefined; }
  return jestWorktreeProblem(packageText, file ?? inline);
}

/** `pullboard doctor --hosts`: one line per role naming the hosts and ports it needs, for a sandbox allowlist [P7]. */
function runHosts(io) {
  const roles = roleHosts({ boardUrl: boardRemote()?.url, trunk: trunkRemote(io.cwd) });
  io.result?.({ hosts: roles });
  for (const [role, hosts] of Object.entries(roles)) io.say(`${role}: ${hosts.join(' ') || 'no network host'}`);
  return 0;
}

// A malformed bare checkout must be diagnosed before trying to open its board.
export const nativeBoardRequired = false;

/** Run `pullboard doctor` and return its exit code. */
export async function run(io, { values = {} } = {}) {
  const bare = bareWorktreeFinding(io.cwd);
  if (bare) {
    const problems = [bare];
    io.result?.({ problems });
    for (const problem of problems) io.say(`problem: ${problem.message}; repair: ${problem.next}`);
    return 1;
  }
  if (values.hosts) return runHosts(io);
  await io.prepareProcessPorts();
  io.nativeBoard ??= await io.loadNativeBoard();
  const ctx = context(io);
  const agentHooks = agentHookStatus(ctx.info.root);
  const problems = [...doctorProblems(ctx.file, ctx.info.root, tryGit, ctx.config, { isMain: ctx.allowSchemaUpgrade, checkAtCommit, release: packageData.version }), ...skillProblems(ctx.info.root), ...doctrineProblems(ctx.info.root, ctx.config), ...unlinkedRelayProjects(), ...runnerServiceProblems()];
  // Preserve doctor's read-only diagnosis of a missing or incompatible board before projecting its rows.
  const incompatible = new Set(['BOARD_MISSING', 'BOARD_TOO_OLD', 'SCHEMA_VERSION', 'EVENT_LOG_VERSION', 'TABLE_MISSING', 'COLUMN_MISSING', 'ITEM_FIELDS']);
  const cover = problems.some(problem => incompatible.has(problem.code)) ? { missingFamilies: [] }
    : withBoardRead(ctx, board => reviewFamilyCover(ctx.info, board, ctx.config));
  for (const family of cover.missingFamilies) problems.push({ code: 'REVIEW_FAMILY_COVER',
    message: `${family} has no registered reviewer wake from another declared family`,
    next: `enroll an independent reviewer from another family with pullboard join <lane> --family <vendor> --wake <executable>` });
  // A gate job nobody has claimed for 2 minutes while no runner is live waits on a missing runner, not on a slow gate.
  if (!problems.some(problem => incompatible.has(problem.code)) && !anyRunnerLive()) for (const job of withBoardRead(ctx, board => unclaimedGateJobs(board.db))) problems.push({ code: 'GATE_NO_RUNNER',
    message: `gate job ${job.id} waited over 2 min with no runner`,
    next: 'run pullboard runner add <ssh-host> or pullboard submit again to start the local runner' });
  problems.push(...appDaemonProblems({ daemons: residentDaemons(ctx.info.root), runners: loadMachineSettings().runners ?? [] }));
  const { detectLanguages, languageToolchains } = await import('../../../../../packages/gate/index.js');
  problems.push(...toolchainProblems(languageToolchains(detectLanguages(ctx.info.root)).toolchains, loadMachineSettings().runners ?? []));
  const jest = jestProblem(ctx.info.root);
  if (jest) problems.push(jest);
  // A managed repo with no background git maintenance slows every git command as loose objects pile up (#10782).
  const maintenanceProblem = (await import('../init/git-maintenance.js')).gitMaintenanceProblem(ctx.info.root, ctx.info.commonDir);
  if (maintenanceProblem) problems.push(maintenanceProblem);
  const trunkProblem = trunkUpdateInsteadProblem(trunkRemote(io.cwd), ctx.info.root, 'refs/heads/main');
  if (trunkProblem) problems.push(trunkProblem);
  const outdated = outdatedSender();
  if (outdated) problems.push({ code: 'RELAY_SENDER_OUTDATED', message: outdatedSenderLine(outdated),
    next: 'run pullboard relay recover to stop it and start this version\'s sender' });
  const checkpointProblem = pendingCheckpointProblem(ctx.info.root);
  if (checkpointProblem) problems.push(checkpointProblem);
  const oversizedSnapshot = checkpointProblem ? null : pendingSnapshotSize(ctx.info.root);
  if (oversizedSnapshot) problems.push({ code: 'RELAY_SNAPSHOT_LIMIT',
    message: formatSnapshotLimit(oversizedSnapshot),
    next: 'reduce the sealed board snapshot below the relay limit, then run pullboard status' });
  // With the runs_store flag on, one reconciler tick settles board-and-runs disagreements and names what it settled [B2,P7].
  const incompatibleBoard = problems.some(problem => incompatible.has(problem.code));
  const settled = !incompatibleBoard && withBoardRead(ctx, board => runsStoreOn(board.db)) ? withBoard(ctx, board => settleOnce(board, ctx.file)) : null;
  io.result?.({ problems, agentHooks, ...(settled ? { reconciled: settled } : {}) });
  if (settled) io.say(reconcilerLine(settled));
  for (const hook of agentHooks.filter(hook => hook.configured)) io.say(`${hook.vendor} agent hooks: ${hook.events.join(', ') || 'not installed'}${hook.trust ? '; trust unverified: the Stop reminder may be off; review /hooks' : ''}`);
  if (!problems.length) {
    io.say('board is clean');
    return 0;
  }
  for (const problem of problems) if (problem !== checkpointProblem) io.say(`problem: ${problem.message}; repair: ${problem.next}`);
  return 1;
}
