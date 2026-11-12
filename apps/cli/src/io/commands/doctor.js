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
import { withBoardRead } from '../context.js';
import {
  bareWorktreeFinding,
  tryGit,
} from '../../../../../packages/git/index.js';
import {
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
  const problems = [...doctorProblems(ctx.file, ctx.info.root, tryGit, ctx.config, { isMain: ctx.allowSchemaUpgrade, checkAtCommit }), ...skillProblems(ctx.info.root), ...doctrineProblems(ctx.info.root, ctx.config), ...unlinkedRelayProjects(), ...runnerServiceProblems()];
  // Preserve doctor's read-only diagnosis of a missing or incompatible board before projecting its rows.
  const incompatible = new Set(['BOARD_MISSING', 'SCHEMA_VERSION', 'EVENT_LOG_VERSION', 'TABLE_MISSING', 'COLUMN_MISSING', 'ITEM_FIELDS']);
  const cover = problems.some(problem => incompatible.has(problem.code)) ? { missingFamilies: [] }
    : withBoardRead(ctx, board => reviewFamilyCover(ctx.info, board, ctx.config));
  for (const family of cover.missingFamilies) problems.push({ code: 'REVIEW_FAMILY_COVER',
    message: `${family} has no registered reviewer wake from another declared family`,
    next: `enroll an independent reviewer from another family with pullboard join <lane> --family <vendor> --wake <executable>` });
  const checkpointProblem = pendingCheckpointProblem(ctx.info.root);
  if (checkpointProblem) problems.push(checkpointProblem);
  const oversizedSnapshot = checkpointProblem ? null : pendingSnapshotSize(ctx.info.root);
  if (oversizedSnapshot) problems.push({ code: 'RELAY_SNAPSHOT_LIMIT',
    message: formatSnapshotLimit(oversizedSnapshot),
    next: 'reduce the sealed board snapshot below the relay limit, then run pullboard status' });
  io.result?.({ problems, agentHooks });
  for (const hook of agentHooks.filter(hook => hook.configured)) io.say(`${hook.vendor} agent hooks: ${hook.events.join(', ') || 'not installed'}${hook.trust ? '; trust unverified: the Stop reminder may be off; review /hooks' : ''}`);
  if (!problems.length) {
    io.say('board is clean');
    return 0;
  }
  for (const problem of problems) if (problem !== checkpointProblem) io.say(`problem: ${problem.message}; repair: ${problem.next}`);
  return 1;
}
