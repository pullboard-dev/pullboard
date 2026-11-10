/**
 * The command line's help: the overview, each command's usage and the nearest command to a typo, all built from
 * the command declarations. A command that is not asking for help never loads it [C7].
 */
import {
  COMMANDS,
  UNLISTED_COMMANDS,
} from './commands/index.js';
import { buildHelp } from '../logic/help.js';

/** Find the nearest declared command for a useful typo hint. */
function closestHelpCommand(input) {
  const needle = input.toLowerCase();
  /** Measure edit distance between two command names for a useful typo hint. */
  const distance = (left, right) => {
    let row = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      const next = [i];
      for (let j = 1; j <= right.length; j += 1) {
        next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      }
      row = next;
    }
    return row.at(-1);
  };
  return Object.keys(HELP.commands).sort((a, b) => distance(needle, a) - distance(needle, b) || a.localeCompare(b))[0];
}

/** Render one command's usage, one-line flags and a pasteable example from the help declaration. */
function commandHelp(name) {
  const entry = HELP.commands[name];
  if (!entry) return null;
  return [
    `Usage: ${entry.usages[0]}`,
    ...entry.usages.slice(1).map((usage) => `       ${usage}`),
    'Flags:',
    ...(entry.flags.length ? entry.flags.map((flag) => `  ${flag}`) : ['  none']),
    ...(name === 'spec' ? [
      'Subcommands:',
      '  pullboard spec --json — agent or person: print the parsed spec and practice rows',
      '  pullboard spec check — agent or person: lint the spec and practice files',
      '  pullboard spec view — agent or person: write the offline spec page',
      '  pullboard spec show <id> — agent or person: inspect one row and its sign-offs',
      '  pullboard spec unmet — agent or person: list approved rows without current sign-off',
      '  pullboard spec draft <text> [--section <letter>] [--aim] [--gate "<gate>"] — any agent: append a draft row; never approve it',
      '  pullboard spec signoff <ids> — person: sign rows with evidence',
      '  pullboard spec signers add — person: register an SSH signing key',
      '  pullboard spec approve <ids> — person: decide from their own terminal or Pullboard View',
      '  pullboard spec decline <ids> — person: decide from their own terminal or Pullboard View',
      '  pullboard spec answer <id> "<choice or text>" — person: answer a pending question from their own terminal or Pullboard View',
      '  pullboard spec apply — coordinator: apply recorded row decisions to the files',
    ] : []),
    'Example:',
    ...entry.example.split('\n').map((line) => `  ${line}`), ...entry.notes,
  ].join('\n');
}

/** Write a selected help view in text and the stable help:string JSON field. */
export function printHelp(io, text) {
  io.result?.({ help: text });
  io.say(text);
  return 0;
}

/** Refuse an unknown command with its nearest declared spelling and a route to the full list. */
export function unknownCommand(io, input) {
  const closest = closestHelpCommand(input);
  io.err(`pullboard: no command "${input}"; closest match is "${closest}". Run pullboard help --all for the full list.`);
  return 2;
}

/** Resolve overview, command detail or the preserved full list from one invocation. */
export function selectedHelp(command, first, second, rest, values) {
  if (command === 'help') {
    if (values.all) return { text: HELP.all };
    const requested = [first, second, ...rest].filter(Boolean).join(' ');
    if (!requested || values.help && !first) return { text: HELP.overview };
    return { name: requested, text: commandHelp(requested) };
  }
  if (values.all && (!command || command === 'help')) return { text: HELP.all };
  if (!command) return { text: HELP.firstRun };
  if (values.help) {
    const words = [command, first, second, ...rest].filter(Boolean);
    const candidates = words.map((_, index) => words.slice(0, index + 1).join(' ')).filter((name) => HELP.commands[name]);
    const nested = candidates.at(-1) ?? command;
    return { name: nested, text: commandHelp(nested) };
  }
  return null;
}
/** Result-producing command names, including aliases, for API contract coverage (A1). */
export function resultCommands() {
  return Object.keys(COMMANDS).filter((name) => !UNLISTED_COMMANDS.includes(name)).sort();
}

/** Command help follows the same dispatch declarations as execution. */
export const HELP = buildHelp(resultCommands());
