import { viewApiPorts } from '../../../../view/index.js';
/** The pullboard watch command, in its own module so an item adding another command never edits these lines. */
import { nativeBoardOpeners } from '../context.js';
import { runningView } from '../../../../view/index.js';
import { refusalDocument } from '../../logic/step/words.js';
import {
  watchCommand,
} from '../../../../../packages/shouts/index.js';
import {
  context,
  main,
  primaryCheckoutRoot,
} from '../entry.js';

/** Run `pullboard watch` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  return await watchCommand({ viewPorts: viewApiPorts, boardOpeners: nativeBoardOpeners(io), io, values, words: [first, second, ...rest], ctx: context(io), primaryCheckoutRoot, runCommand: io.runCommand, runningView, refusalDocument });
}
