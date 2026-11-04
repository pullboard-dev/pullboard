/** The pullboard prompt command, in its own module so an item adding another command never edits these lines. */
import {
  repoInfo,
} from '../../../../../packages/git/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  promptFor,
} from '../skills.js';

/** Run `pullboard prompt` and return its exit code. */
export function run(io, { first }) {
  let root = io.cwd;
  try {
    root = repoInfo(io.cwd).root;
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
  }
  const text = promptFor(root, first ?? '').trimEnd();
  io.result?.({ role: first, text });
  io.say(text);
  return 0;
}
