/** The pullboard flakes command, in its own module so an item adding another command never edits these lines. */
import {
  command as flakesCommand,
  recordSuiteRun,
} from '../../../../../packages/flakes/index.js';
import {
  context,
  ordered,
  resourceAgent,
  withBoard,
} from '../entry.js';

/** Run `pullboard flakes` and return its exit code. */
export async function run(io, { first, second, rest }) {
  // Hidden: packages/gate/src/io/run/tests.js records its direct suite receipt here, in this process's composition.
  if (first === 'record-suite') { await recordSuiteRun(io.cwd, second, { context, ordered, withBoard, resourceAgent, nativeBoard: io.nativeBoard }); return 0; }
  return flakesCommand(context(io), { first, second, rest }, withBoard, { ordered, resourceAgent });
}
