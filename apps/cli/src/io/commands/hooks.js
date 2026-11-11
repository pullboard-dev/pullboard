/** The pullboard hooks command, in its own module so an item adding another command never edits these lines. */
import {
  repoInfo,
} from '../../../../../packages/git/index.js';
import {
  installHooks,
} from '../../../../../packages/commits/index.js';
import { configureAgentHooks } from '../../../../../packages/seats/index.js';

/** Run `pullboard hooks` and return its exit code. */
export function run(io, { first } = {}) {
  const root = repoInfo(io.cwd).root;
  const notes = first === 'uninstall' ? configureAgentHooks(root, { remove: true })
    : [...installHooks(root), ...configureAgentHooks(root)];
  io.result?.({ notes });
  notes.forEach((note) => io.say(note));
  return 0;
}
