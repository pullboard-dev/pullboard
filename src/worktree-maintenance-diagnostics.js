/** Maintenance diagnostics retain actual failures and completed runs without changing scheduling [B3,C7]. */
import { constants } from 'node:fs';
import { closeSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { readSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

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
    if (create) try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const state = lstatSync(directory);
    if (!state.isDirectory() || state.isSymbolicLink() || name === 'worktree-maintenance' && state.mode & 0o077)
      throw new Error('maintenance diagnostic directory is not private');
  }
  return directory;
}

/** Observe only a bounded, private regular diagnostic file, never an arbitrary symlink target. */
export function readMaintenanceLastRun(common) {
  let fd;
  try {
    fd = openSync(join(diagnosticDirectory(common, false), 'last-run.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const state = fstatSync(fd);
    if (!state.isFile() || state.size > 4096 || state.mode & 0o077) throw new Error('invalid maintenance last-run diagnostic');
    const bytes = Buffer.alloc(4097);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null))) length += count;
    if (length > 4096) throw new Error('maintenance last-run diagnostic exceeds bound');
    const after = fstatSync(fd);
    if (state.size !== after.size || state.mtimeMs !== after.mtimeMs || state.ctimeMs !== after.ctimeMs)
      throw new Error('maintenance last-run diagnostic changed during observation');
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (value.version !== 1 || !Number.isFinite(Date.parse(value.completedAt)) || value.code !== 0)
      throw new Error('invalid maintenance last-run diagnostic');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Record a successfully completed native maintenance command; this is not permission to schedule or clean. */
export function recordMaintenanceLastRun(common) {
  const directory = diagnosticDirectory(common, true);
  const temporary = join(directory, `last-run.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify({ version: 1, completedAt: new Date().toISOString(), code: 0 }) + '\n');
    closeSync(fd); fd = undefined;
    renameSync(temporary, join(directory, 'last-run.json'));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
