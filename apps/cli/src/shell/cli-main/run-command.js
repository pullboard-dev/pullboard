/** Dispatch one parsed command through the lazy command table and render its refusal [C7]. */
import { COMMANDS } from '../commands/index.js';
import { Refused } from '../../../../../packages/kernel/core.js';
import { parseCommandArgs } from './options.js';

/**
 * Run one command. Returns the exit code: 0 done, 1 refused, 2 usage.
 *
 * @param {string[]} argv
 * @param {any} io
 * @returns {Promise<number>}
 */
export async function runCommand(argv, io) {
  let parsed;
  try {
    parsed = parseCommandArgs(argv);
  } catch (error) {
    // A parse error that names its own refusal code (REPEATED_FLAG) keeps it; any other parse error is usage.
    const refusal = new Refused(typeof error.refusalCode === 'string' ? error.refusalCode : 'USAGE', `${error.message}; run pullboard help`);
    // The values never parsed, so the JSON switch is read from the arguments: the refusal code must survive in --json output.
    io.jsonMode?.(argv.includes('--json'));
    await io.prepareRefusal();
    io.refusal?.(refusal);
    io.err(`pullboard: ${error.message}\nRun pullboard help --all for the full list.\nnext: ${io.refusalDocument(refusal).error.next}`);
    return 2;
  }
  const { values, positionals } = parsed;
  io.jsonMode?.(values.json);
  const [command = '', first, second, ...rest] = positionals;
  const args = { first, second, rest, values };
  if ((values.version || command === 'version') && !values.help) return await (await COMMANDS.version()).run(io, args);
  // Help loads only when asked for: a command name other than help, without --help, never needs it.
  const help = !command || command === 'help' || values.help
    ? (await import('../cli-help.js')).selectedHelp(command, first, second, rest, values) : null;
  if (help) return await (await COMMANDS.help()).run(io, args, help);
  try {
    if (values.as === 'person' && !['answer', 'decisions', 'fact', 'hold', 'add', 'edit'].includes(command) && !(command === 'bar' && first === 'sign')) {
      throw new Refused('USAGE', '--as person works with answer, decisions, fact --never-again, hold, add, edit, or bar sign');
    }
    const load = COMMANDS[command];
    if (!load) return (await import('../cli-help.js')).unknownCommand(io, command);
    await (await import('../exit-rules-runtime.js')).enforceExitBoundary(io, command);
    const commandModule = await load();
    if (commandModule.nativeBoardRequired !== false) {
      await io.prepareProcessPorts();
      io.nativeBoard ??= await io.loadNativeBoard();
    }
    return await commandModule.run(io, args);
  } catch (error) {
    error = (await import('../../../../../packages/state/index.js')).recordedMoveRefusal(io, error);
    if (error instanceof Refused && error.code === 'RUNNER_TOOLING_CHANGED' && io.submitToolingAttempt?.owned) {
      const { prepareSubmitToolingRetry } = await import('../../../../../packages/runners/index.js');
      const selection = prepareSubmitToolingRetry(io.submitToolingAttempt.snapshot, io.submitToolingAttempt);
      if (selection) {
        io.submitToolingAttempt.retry = selection;
        io.submitToolingAttempt.error = error;
        return 1;
      }
    }
    if (error instanceof Refused) {
      io.refusal?.(error);
      io.err(`pullboard: ${await displayedRefusal(io, error)}\nnext: ${io.refusalDocument(error).error.next}`);
      (await import('../next-steps.js')).reportBlock(io, error, { command });
      return 1;
    }
    throw error;
  }
}

/** Render a refusal with agents' display names, loading the board only for a refusal that names one. */
export async function displayedRefusal(io, error) {
  await io.prepareRefusal();
  const cli = await import('../cli-context.js');
  if (cli.refusalNeedsBoard(error)) io.nativeBoard ??= await io.loadNativeBoard();
  return cli.displayedRefusal(io, error);
}
