import { checkAtCommit } from '../runner-private-check.js';
/** The pullboard doctor command, in its own module so an item adding another command never edits these lines. */
import {
  doctorProblems,
  doctrineProblems,
} from '../doctor.js';
import {
  bareWorktreeFinding,
  tryGit,
} from '../git.js';
import {
  unlinkedRelayProjects,
} from '../relay-setup.js';
import {
  formatSnapshotLimit,
  pendingCheckpointProblem,
  pendingSnapshotSize,
} from '../relay.js';
import {
  skillProblems,
} from '../skills.js';
import {
  context,
} from '../cli.js';
import { agentHookStatus } from '../agent-hooks.js';

/** Run `pullboard doctor` and return its exit code. */
export function run(io) {
  const bare = bareWorktreeFinding(io.cwd);
  if (bare) {
    const problems = [bare];
    io.result?.({ problems });
    for (const problem of problems) io.say(`problem: ${problem.message}; repair: ${problem.next}`);
    return 1;
  }
  const ctx = context(io);
  const agentHooks = agentHookStatus(ctx.info.root);
  const problems = [...doctorProblems(ctx.file, ctx.info.root, tryGit, ctx.config, { isMain: ctx.allowSchemaUpgrade, checkAtCommit }), ...skillProblems(ctx.info.root), ...doctrineProblems(ctx.info.root, ctx.config), ...unlinkedRelayProjects()];
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
