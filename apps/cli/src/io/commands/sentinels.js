/** The pullboard sentinels command, in its own module so an item adding another command never edits these lines. */
import {
  sentinelListCommand,
} from '../../../../../packages/sentinels/index.js';
import {
  context,
  withBoard,
} from '../entry.js';

/** Run `pullboard sentinels` and return its exit code. */
export function run(io, { first }) {
  return sentinelListCommand(first, () => context(io), withBoard);
}
