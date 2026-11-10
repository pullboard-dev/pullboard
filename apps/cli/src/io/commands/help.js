/** The pullboard help command, in its own module so an item adding another command never edits these lines. */
import { loadConfig } from '../../../../../packages/config/index.js';
import {
  context,
  primaryCheckoutRoot,
  printHelp,
  unavailableWorktreeLocation,
  unknownCommand,
  worktreeLocation,
} from '../entry.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Print the help the dispatcher selected for this command line, or name an unknown command, and return its exit code. */
export function run(io, args, help) {
  if (help.text) {
    let text = help.text;
    if (help.name === 'worktree') {
      try {
        const ctx = context(io);
        const mainRoot = primaryCheckoutRoot(ctx.info);
        const worktreeConfig = mainRoot ? (ctx.info.isMain ? ctx.config : loadConfig(mainRoot)) : null;
        text += `\nActive worktree location: ${mainRoot
          ? worktreeLocation(mainRoot, worktreeConfig)
          : unavailableWorktreeLocation()}.`;
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
      }
    }
    return printHelp(io, text);
  }
  return unknownCommand(io, help.name);
}
