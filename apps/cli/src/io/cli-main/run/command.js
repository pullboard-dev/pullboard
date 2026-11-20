/** Dispatch one parsed command through the lazy command table and render its refusal [C7]. */
import { COMMANDS } from '../../commands/index.js';
import { Refused } from '../../../../../../packages/kernel/light.js';
import { parseCommandArgs } from '../options.js';

/** The seat commands that say a seat's returned rejections first when next.returnedFirst is on [C7,#2220]. */
const RETURNED_FIRST_COMMANDS = new Set(['next', 'claim', 'submit', 'show', 'fact']);

/**
 * Say one line per open item this seat built that a verifier rejected, before the command's own lines.
 * Why: a rejected builder reads the reason at once instead of finding it by hand; everything loads lazily so the setting off adds no module to a cold command [C7,#2220].
 * A seat that cannot be identified or a board that cannot be read says nothing: the echo never refuses the command it precedes.
 *
 * @param {any} io
 * @returns {Promise<void>}
 */
async function sayReturnedFirst(io) {
  const { nextReturnedFirst } = await import('../../../../../../packages/config/index.js');
  if (!nextReturnedFirst()) return;
  try {
    const { context } = await import('../../read.js');
    const { whoAmI } = await import('../../join.js');
    const { withBoardRead } = await import('../../board/read.js');
    const { returnedEchoLines } = await import('../../next/returned.js');
    const ctx = context(io);
    const lines = await withBoardRead(ctx, (board, store) => {
      const verdictFor = id => store.verdictsFor(board, id).filter(verdict => verdict.verdict_decision === 'REJECT').at(-1);
      return returnedEchoLines(store.listItems(board), verdictFor, whoAmI(ctx, board).id);
    });
    for (const line of lines) io.say(line);
  } catch { /* no joined seat or no readable board: nothing was returned to say */ }
}

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
  // --level is the approved name (U136); --route still works, and the line goes to stderr so no document or stdout reader sees it.
  if (argv.some(token => token === '--route' || token.startsWith('--route='))) io.err('pullboard: --route is now --level; give --level light|mid|strong');
  if (argv.some(token => token === '--review-tier' || token.startsWith('--review-tier='))) io.err('pullboard: --review-tier is now --review; give --review standard|strict');
  const [command = '', first, second, ...rest] = positionals;
  const args = { first, second, rest, values };
  if ((values.version || command === 'version') && !values.help) return await (await COMMANDS.version()).run(io, args);
  // Help loads only when asked for: a command name other than help, without --help, never needs it.
  const help = !command || command === 'help' || values.help
    ? (await import('../../help.js')).selectedHelp(command, first, second, rest, values) : null;
  if (help) return await (await COMMANDS.help()).run(io, args, help);
  try {
    if (values.as === 'person' && !['answer', 'decisions', 'fact', 'hold', 'add', 'edit', 'milestone'].includes(command) && !(command === 'bar' && first === 'sign')) {
      throw new Refused('USAGE', '--as person works with answer, decisions, fact --never-again, hold, add, edit, milestone ship, or bar sign');
    }
    const load = COMMANDS[command];
    if (!load) return (await import('../../help.js')).unknownCommand(io, command);
    await (await import('../../exit/rules.js')).enforceExitBoundary(io, command);
    const commandModule = await load();
    if (commandModule.nativeBoardRequired !== false) {
      await io.prepareProcessPorts();
      io.nativeBoard ??= await io.loadNativeBoard();
    }
    if (RETURNED_FIRST_COMMANDS.has(command)) await sayReturnedFirst(io);
    return await commandModule.run(io, args);
  } catch (error) {
    error = (await import('../../../../../../packages/state/index.js')).recordedMoveRefusal(io, error);
    if (error instanceof Refused && error.code === 'RUNNER_TOOLING_CHANGED' && io.submitToolingAttempt?.owned) {
      const { prepareSubmitToolingRetry } = await import('../../../../../../packages/runners/index.js');
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
      (await import('../../next/steps.js')).reportBlock(io, error, { command });
      return 1;
    }
    throw error;
  }
}

/** Render a refusal with agents' display names, loading the board only for a refusal that names one. */
export async function displayedRefusal(io, error) {
  await io.prepareRefusal();
  const cli = await import('../../context.js');
  if (cli.refusalNeedsBoard(error)) io.nativeBoard ??= await io.loadNativeBoard();
  return cli.displayedRefusal(io, error);
}
