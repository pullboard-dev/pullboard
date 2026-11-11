/** Classify requested command intent before an ordered relay refusal is reported. */
const ORDERED_MOVE_COMMANDS = new Set(['add', 'edit', 'move', 'fact', 'escalate', 'run', 'sweep', 'next', 'claim', 'hold', 'release',
  'submit', 'done', 'verify', 'merged', 'land', 'withdraw', 'refreeze', 'shout', 'answer', 'pass', 'import', 'milestone', 'takeover', 'forget', 'join', 'worktree']);

/** Whether the CLI command will make an ordered move whose refusal should be reported at dispatch. */
export function orderedMoveCommand(io) {
  const command = io.relayCommand;
  if (command?.cliOperation === 'patch') return ['attach', 'remove'].includes(command.positionals?.[0]);
  if (command?.cliOperation === 'request') return Boolean(command.positionals?.[0] && command.positionals[0] !== 'list');
  if (command?.cliOperation === 'rule') return Boolean(command.positionals?.[0] && command.positionals[0] !== 'list');
  if (command?.cliOperation === 'spec') return ['approve', 'decline', 'apply'].includes(command.positionals?.[0]);
  return ORDERED_MOVE_COMMANDS.has(command?.cliOperation);
}
