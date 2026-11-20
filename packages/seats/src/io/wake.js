/** Machine-local wake capabilities never travel in board moves or relay snapshots [C7]. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync } from 'node:fs';
import { constants } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { sameCommonDir } from '../../../git/index.js';
import { renameSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { processMachineHome as machineHome } from '../../../kernel/light.js';
import { Refused } from '../../../kernel/index.js';
import { environmentAdapter } from '../../../env/index.js';

/** Resolve one executable now; a wake is not a shell expression or an argv prefix. */
export function seatWakeCommand(command, root) {
  if (command === undefined) return undefined;
  if (typeof command !== 'string' || !command || /[\0\r\n]/u.test(command)) {
    throw new Refused('WAKE_COMMAND', 'give --wake the path of an executable that accepts only the item id');
  }
  const paths = isAbsolute(command) || command.includes('/') ? [resolve(root, command)]
    : (environmentAdapter().get('PATH') ?? '').split(delimiter).map(directory => resolve(directory || root, command));
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return realpathSync(path);
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Refused('WAKE_COMMAND', 'give --wake an existing executable path; put shell logic in that executable, not in --wake');
}

/** Scope each private capability to this machine, board and exact registered seat. */
function wakeFile(boardId, seat) {
  const key = createHash('sha256').update(JSON.stringify([boardId, seat])).digest('hex');
  return join(machineHome(), 'seat-wakes', key + '.json');
}

/** Only a successful local join grants authority to execute a command for this seat. */
export function registerSeatWake(info, boardId, seat, command) {
  if (command === undefined) return;
  const file = wakeFile(boardId, seat);
  mkdirSync(join(machineHome(), 'seat-wakes'), { recursive: true, mode: 0o700 });
  const pending = file + '.' + process.pid + '.tmp';
  writeFileSync(pending, JSON.stringify({ version: 1, boardId, seat, root: realpathSync(info.root),
    commonDir: realpathSync(info.commonDir), command }) + '\n', { mode: 0o600 });
  renameSync(pending, file);
}

/** Read only a capability registered locally for this exact board and checkout. */
function registeredWake(info, boardId, seat) {
  if (!seat) return null;
  let registration;
  try {
    registration = JSON.parse(readFileSync(wakeFile(boardId, seat.agent_id), 'utf8'));
    if (registration.version !== 1 || registration.boardId !== boardId || registration.seat !== seat.agent_id
      || registration.root !== realpathSync(seat.agent_path) || !sameCommonDir(registration.commonDir, realpathSync(info.commonDir))
      || typeof registration.command !== 'string' || !isAbsolute(registration.command)) return null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  }
  return registration;
}

/** Report local wake availability without copying the private executable into shared board state. */
export function hasSeatWake(info, { boardId, seat }) {
  return registeredWake(info, boardId, seat) !== null;
}

/** Wake a dormant locally enrolled seat after routing commits, without ever holding the board writer. */
export async function wakeRoutedSeat(info, { boardId, seat, item }) {
  if (!['idle', 'gone'].includes(seat?.presence) || !Number.isSafeInteger(item) || item < 1) return { woke: false };
  const registration = registeredWake(info, boardId, seat);
  if (!registration) return { woke: false };
  return new Promise(resolveWake => {
    const child = spawn(registration.command, [String(item)], { cwd: registration.root, shell: false, stdio: 'ignore' });
    let finished = false;
    /** Complete once even when an executable error is followed by close. */
    const finish = result => { if (!finished) { finished = true; clearTimeout(timer); resolveWake(result); } };
    const timer = setTimeout(() => { child.kill('SIGTERM'); child.unref(); finish({ woke: false, error: 'wake command timed out' }); }, 30_000);
    child.once('error', error => finish({ woke: false, error: error.message }));
    child.once('close', code => finish(code === 0 ? { woke: true } : { woke: false, error: `wake command exited ${code}` }));
  });
}
