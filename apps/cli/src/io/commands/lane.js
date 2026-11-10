/** The pullboard lane command, in its own module so an item adding another command never edits these lines. */
import {
  CONFIG_FILE,
} from '../../../../../packages/config/index.js';
import {
  repoInfo,
} from '../../../../../packages/git/index.js';
import {
  addLane,
} from '../../../../../packages/seats/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';

/** Run `pullboard lane` and return its exit code. */
export function run(io, { first, second, rest, values }) {
  if (first !== 'add' || !second || rest.length || values.owns === undefined) {
    throw new Refused('USAGE', 'add a lane with: pullboard lane add <name> --owns <path>[,<path>]');
  }
  const info = repoInfo(io.cwd);
  if (!info.isMain) throw new Refused('NOT_MAIN', 'lanes are the coordinator\'s to declare; run pullboard lane add in the main checkout, or shout the coordinator to add it');
  const added = addLane(info.root, second, values.owns.split(','));
  io.result?.(added);
  io.say(`added lane ${added.lane}: owns ${added.owns.join(' ')}`);
  io.say(`Next: commit ${CONFIG_FILE} so new worktrees can join it, then: pullboard worktree ${added.lane} --model "<model name>"`);
  return 0;
}
