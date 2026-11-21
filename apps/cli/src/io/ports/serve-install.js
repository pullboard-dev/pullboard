/** `pullboard serve install` and `serve uninstall`: the opt-in supervised board API service, wired to the real disk and launchctl [P7]. */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBoardService } from '../../../../../packages/api/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { git } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { context } from '../entry.js';

const fs = fileSystemAdapter();
const CLI = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));

/** Run launchctl; true when it exits 0. */
function launchctl(args) {
  return new Promise((done, fail) => execFile('launchctl', args, (error) => {
    if (error?.code === 'ENOENT') fail(new Refused('USAGE', 'launchctl is not on this machine; pullboard serve install needs macOS launchd, so elsewhere run pullboard serve under systemd with Restart=always'));
    else done(!error);
  }));
}

/**
 * Install the board API as a launchd service, or remove it. Nothing installs unless a person runs this command.
 *
 * @param {any} io
 * @param {{ remove: boolean, values: Record<string, any> }} request
 * @returns {Promise<number>}
 */
export async function runServeInstall(io, { remove, values }) {
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Refused('USAGE', '--port is a number from 0 to 65535');
  const root = git(context(io).info.root, ['worktree', 'list', '--porcelain']).split('\n')[0].slice('worktree '.length);
  const home = homedir();
  const result = await installBoardService({ uid: process.getuid(), home, node: process.execPath, cli: CLI, root,
    address: values.address, port, remove }, {
    write: (file, text) => { fs.mkdir(dirname(file), { recursive: true }); fs.mkdir(`${home}/.pullboard`, { recursive: true }); fs.writeFile(file, text); },
    remove: (file) => fs.rm(file, { force: true }),
    launchctl,
  });
  io.result?.(result);
  io.say(remove ? `removed the board API service ${result.label}` : `installed the board API as launchd service ${result.label}, restarting on exit; log ${result.log}`);
  return 0;
}
