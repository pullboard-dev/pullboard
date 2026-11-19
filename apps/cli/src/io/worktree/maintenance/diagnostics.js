/** Maintenance diagnostics retain actual failures and completed runs without changing scheduling [B3,C7]. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();
const { constants } = fs;

/** Keep error codes and messages legible on one bounded diagnostic line. */
export function maintenanceTimerWarning(error) {
  const stage = ['lookup', 'register', 'launch'].includes(error?.maintenanceStage) ? error.maintenanceStage : 'lookup';
  const code = String(error?.code ?? error?.name ?? 'Error').replace(/[\r\n\t]/gu, ' ').slice(0, 80);
  const message = String(error?.message ?? error).replace(/[\r\n\t]/gu, ' ').slice(0, 500);
  return `maintenance timer could not be registered; stage=${stage}; ${code}: ${message}`;
}

/** Preserve private repository diagnostic custody without following a substituted directory. */
function diagnosticDirectory(common, create) {
  let directory = common;
  for (const name of ['pullboard', 'worktree-maintenance']) {
    directory = join(directory, name);
    if (create) try { fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const state = fs.lstat(directory);
    if (!state.isDirectory() || state.isSymbolicLink() || name === 'worktree-maintenance' && state.mode & 0o077)
      throw new Error('maintenance diagnostic directory is not private');
  }
  return directory;
}

/** Observe only a bounded, private regular diagnostic file, never an arbitrary symlink target. */
export function readMaintenanceLastRun(common) {
  let fd;
  try {
    fd = fs.open(join(diagnosticDirectory(common, false), 'last-run.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const state = fs.fstat(fd);
    if (!state.isFile() || state.size > 4096 || state.mode & 0o077) throw new Error('invalid maintenance last-run diagnostic');
    const bytes = Buffer.alloc(4097);
    let length = 0, count;
    while (length < bytes.length && (count = fs.read(fd, bytes, length, bytes.length - length, null))) length += count;
    if (length > 4096) throw new Error('maintenance last-run diagnostic exceeds bound');
    const after = fs.fstat(fd);
    if (state.size !== after.size || state.mtimeMs !== after.mtimeMs || state.ctimeMs !== after.ctimeMs)
      throw new Error('maintenance last-run diagnostic changed during observation');
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (value.version !== 1 || !Number.isFinite(Date.parse(value.completedAt)) || value.code !== 0)
      throw new Error('invalid maintenance last-run diagnostic');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) fs.close(fd); }
}

/** Record a successfully completed native maintenance command; this is not permission to schedule or clean. */
export function recordMaintenanceLastRun(common) {
  const directory = diagnosticDirectory(common, true);
  const temporary = join(directory, `last-run.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fs.write(fd, JSON.stringify({ version: 1, completedAt: new Date().toISOString(), code: 0 }) + '\n');
    fs.close(fd); fd = undefined;
    fs.rename(temporary, join(directory, 'last-run.json'));
  } finally {
    if (fd !== undefined) fs.close(fd);
    try { fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
