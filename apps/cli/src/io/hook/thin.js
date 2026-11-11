/**
 * The thin entry for a Git hook that no agent session runs: pre-commit, pre-merge-commit and commit-msg run hookCommand
 * with a minimal io and a light context, never the full dispatcher, so a fixture commit pays one small module graph [H24].
 * An agent session keeps the full path, which binds its checkout lease first.
 */
import { resolve } from 'node:path';
import { commandOutput } from '../../../../../packages/config/browser.js';
import { loadConfig } from '../../../../../packages/config/light.js';
import { loadDoctrine } from '../../../../../packages/doctrine/light.js';
import { repoInfo } from '../../../../../packages/git/light.js';
import { Refused } from '../../../../../packages/kernel/light.js';
import { hookClock } from '../commands/hook.js';
import { hookCommand } from '../commands/hook.js';

/** The light context a commit hook reads: checkout facts, config, board file and doctrine, with no board writes. */
function lightContext(io) {
  const info = repoInfo(io.cwd);
  if (info.isMain) io.caller?.('coordinator', info.root);
  const config = loadConfig(info.root);
  let doctrine;
  return { info, config, file: resolve(info.commonDir, 'pullboard', 'board.sqlite'), nativeBoard: undefined, io,
    get doctrine() { return doctrine ??= loadDoctrine(info.root, config); }, clock: hookClock };
}

/**
 * Run one commit hook and return its exit code.
 *
 * @param {string[]} args hook, the hook name, then git's arguments
 * @param {{ cwd: string, stdout: any, stderr: any, stdin: any }} streams
 * @returns {Promise<number>}
 */
export async function runThinHook(args, streams) {
  const io = commandOutput(args, streams, { nextActions: false,
    loadRefusal: async () => (await import('../../logic/step/words.js')).refusalDocument });
  io.hookContext = lightContext;
  io.gateWaitReporter = () => () => {};
  try {
    const code = await hookCommand(io, { first: args[1], second: args[2] });
    io.flush(io.exitCode(code));
    return io.exitCode(code);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    io.refusal?.(error);
    await io.prepareRefusal();
    io.err(`pullboard: ${io.guidance(error.message.replace(/\r?\nnext:[ \t]*[^\r\n]*\S[ \t]*(?:\r?\n)*$/u, ''))}\nnext: ${io.refusalDocument(error).error.next}`);
    io.flush(1);
    return 1;
  }
}
