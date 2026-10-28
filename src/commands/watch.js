/** The pullboard watch command, in its own module so an item adding another command never edits these lines. */
import { runningView } from '../view-session.js';
import {
  watchCommand,
} from '../watch.js';
import {
  context,
  main,
  primaryCheckoutRoot,
} from '../cli.js';

/** Run `pullboard watch` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  return await watchCommand({ io, values, words: [first, second, ...rest], ctx: context(io), primaryCheckoutRoot, runCommand: main, runningView });
}
