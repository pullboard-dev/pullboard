/** The pullboard forget command, in its own module so an item adding another command never edits these lines. */
import {
  forgetProject,
} from '../../../../../packages/seats/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  resolve,
} from 'node:path';

/** Run `pullboard forget` and return its exit code. */
export function run(io, { first, second }) {
  if (!first || second) throw new Refused('USAGE', 'pullboard forget <path>');
  const root = resolve(io.cwd, first);
  if (!forgetProject(root)) throw new Refused('NO_REPO', `no registered repo at ${root}; see the projects in pullboard view`);
  io.result?.({ root });
  io.say(`forgot ${root}`);
  return 0;
}
