/**
 * Install the board API as a supervised macOS service, or remove it: `pullboard serve install` writes a LaunchAgent and
 * loads it with launchctl, so the API restarts after a crash [P7]. Nothing here runs unless a person asks for it.
 * The launchctl runner refuses off macOS. The file writes and the runner are ports, so a test checks the definition and the commands without a real supervisor.
 */
import { Refused } from '../../../kernel/index.js';
import { BOARD_SERVICE_LABEL } from '../logic/service.js';
import { boardServiceCommands } from '../logic/service.js';
import { boardServicePlist } from '../logic/service.js';

/**
 * Write the service definition and load it, or unload and delete it.
 *
 * @param {{ uid: number, home: string, node: string, cli: string, root: string, address?: string, port?: number, remove?: boolean }} plan
 * @param {{ write: (file: string, text: string) => void, remove: (file: string) => void, launchctl: (args: string[]) => Promise<boolean> }} ports
 * @returns {Promise<{ label: string, plist: string, log: string, removed: boolean, commands: string[][] }>}
 */
export async function installBoardService({ uid, home, node, cli, root, address, port, remove = false }, { write, remove: removeFile, launchctl }) {
  const plist = `${home}/Library/LaunchAgents/${BOARD_SERVICE_LABEL}.plist`;
  const log = `${home}/.pullboard/board-api.log`;
  const commands = [];
  for (const { args, optional } of boardServiceCommands({ uid, plist, remove })) {
    // The definition is written after the bootout, so a machine without launchctl refuses before any file exists.
    if (args[0] === 'bootstrap') write(plist, boardServicePlist({ node, cli, root, log, home, address, port }));
    commands.push(args);
    const ok = await launchctl(args);
    if (!ok && !optional) throw new Refused('SERVICE_NOT_LOADED', `launchctl ${args.join(' ')} failed, so the board API service is written but not loaded`, `run launchctl ${args.join(' ')} to see why`);
  }
  if (remove) removeFile(plist);
  return { label: BOARD_SERVICE_LABEL, plist, log, removed: remove, commands };
}
