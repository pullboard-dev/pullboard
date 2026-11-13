/** @pullboard-module-loads apps/cli/src/io/commands/*.js */
/**
 * Every command, discovered: each src/commands/<name>.js is the pullboard <name> command and exports run. An item
 * adding a command adds its own new file and no line of any shared one, so two items adding different commands never
 * conflict, even at the same sorted spot [C7,V4]. Modules load on first use, so a command that is not run costs nothing.
 */
import {
  COMMAND_CANDIDATE,
  COMMAND_FILE,
  discovered,
} from '../../../../../packages/kernel/light.js';
import { readdirSync } from 'node:fs';

const FOLDER = new URL('./', import.meta.url);

/** Load one command module by its file name under src/commands/. */
function loader(file) {
  return () => import(new URL(file, FOLDER).href);
}

export const COMMANDS = Object.fromEntries(discovered(readdirSync(FOLDER), COMMAND_CANDIDATE, COMMAND_FILE, 'command')
  // Sort command names rather than filenames: test.js precedes test-value.js as a command.
  .map((file) => [file.slice(0, -'.js'.length), loader(file)])
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));

/** Commands that run but stay out of help and the result-command list. */
export const UNLISTED_COMMANDS = ['check-baseline', 'mcp'];
