/** The pullboard loop command, in its own module so an item adding another command never edits these lines. */
import {
  loopCommand,
} from '../../logic/loop.js';
import {
  context,
  ordered,
  whoAmI,
  withBoard,
} from '../entry.js';

/** Run `pullboard loop` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  return await loopCommand({ ctx: context(io), words: [first, second, ...rest].filter(value => value !== undefined), values, withBoard, whoAmI, ordered });
}
