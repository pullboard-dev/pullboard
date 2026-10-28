/** The pullboard mcp command, in its own module so an item adding another command never edits these lines. */
import {
  serveMcp,
} from '../mcp.js';
import {
  Refused,
} from '../refused.js';
import { personNeeds } from '../row-decision-text.js';
import { personNeedsState } from '../needs-state.js';
import {
  context,
  main,
} from '../cli.js';

/**
 * Serve MCP over stdio as this checkout's agent (A9). Stdout carries only the protocol, so the command
 * takes no --json; each tool call runs its own CLI command, with its own relay sync, through main.
 * A person's move never comes through it (P6).
 */
export async function mcpHere(io, { first, values }) {
  if (first) throw new Refused('USAGE', 'pullboard mcp takes no arguments; run pullboard mcp from the agent\'s worktree');
  if (values.json) throw new Refused('USAGE', 'pullboard mcp speaks MCP on stdout; run pullboard mcp without --json');
  context(io);
  return serveMcp({ cwd: io.cwd, input: io.stdin, output: io.stdout, log: io.stderr, runCommand: main,
    needsYou: (cwd) => personNeeds(personNeedsState(cwd)) });
}

/** Run `pullboard mcp` and return its exit code. */
export async function run(io, args) {
  return await mcpHere(io, args);
}
