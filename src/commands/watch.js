import { viewApiPorts } from '../view-api-ports.js';
/** The pullboard watch command, in its own module so an item adding another command never edits these lines. */
import { nativeBoardOpeners } from '../cli-context.js';
import { runningView } from '../view-session.js';
import { refusalDocument } from '../next-step-words.js';
import {
  watchCommand,
} from '../../packages/shouts/index.js';
import {
  context,
  main,
  primaryCheckoutRoot,
} from '../cli.js';

/** Run `pullboard watch` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  return await watchCommand({ viewPorts: viewApiPorts, boardOpeners: nativeBoardOpeners(io), io, values, words: [first, second, ...rest], ctx: context(io), primaryCheckoutRoot, runCommand: io.runCommand, runningView, refusalDocument });
}
