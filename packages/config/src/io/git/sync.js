/** Read local Git-sharing metadata without loading transport or touching board state [H11,C7]. */
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { repoInfo } from '../../../../git/light.js';
import { Refused } from '../../../../kernel/light.js';

/** Keep the shared marker and its recovery evidence beside this repository's board. */
export function gitSyncFiles(root) {
  const folder = join(repoInfo(root).commonDir, 'pullboard');
  return { folder, marker: join(folder, 'git-sync.json'), quarantine: join(folder, 'quarantine') };
}

/**
 * Read a bounded regular file; a malformed or replaced marker never selects a transport. A board folder replaced by a
 * file (ENOTDIR) is damage no read can repair, so it refuses with the next step instead of throwing a raw error.
 */
export function readGitSyncMarker(root) {
  const { folder, marker } = gitSyncFiles(root);
  let stat, fd;
  try {
    stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return { exists: true, valid: false, stat };
    fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 4096 || opened.ino !== stat.ino || opened.dev !== stat.dev) return { exists: true, valid: false, stat };
    const bytes = readFileSync(fd);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { value = null; }
    const writer = value?.writer;
    const validWriter = writer === undefined || writer && typeof writer === 'object'
      && writer.command === 'sync' && Number.isSafeInteger(writer.pid) && writer.pid > 0
      && typeof writer.at === 'string' && Number.isFinite(Date.parse(writer.at));
    return { exists: true, valid: Boolean(value?.version === 1 && value.remote === 'origin'
      && value.ref === 'refs/pullboard/board' && validWriter), value, stat,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, valid: false };
    if (error.code === 'ELOOP') return { exists: true, valid: false, stat };
    if (error.code === 'ENOTDIR') throw new Refused('GIT_SYNC_FOLDER', `${folder} is not a directory, so the board folder is damaged`,
      `move ${folder} aside, then run pullboard doctor`);
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Only syntactically valid opt-in metadata selects Git sharing; legacy valid markers remain readable. */
export function gitSyncMarkerLinked(root) {
  return readGitSyncMarker(root).valid;
}

/** Detect local artifacts before lazily loading the recovery path for a write. */
export function gitSyncRecoveryNeeded(root) {
  const { marker } = gitSyncFiles(root);
  return existsSync(marker) || existsSync(marker + '.lock');
}

/** Read bounded recovery summaries, never quarantined marker contents or pending user moves. */
export function readGitSyncRepairs(root) {
  const { quarantine } = gitSyncFiles(root);
  let names;
  try { names = readdirSync(quarantine).filter(name => /^git-sync-[A-Za-z0-9-]+$/u.test(name)).sort().slice(-100); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.flatMap(name => {
    try {
      const path = join(quarantine, name, 'recovery.json'), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return [];
      const row = JSON.parse(readFileSync(path, 'utf8'));
      return row?.version === 1 && typeof row.at === 'string' && Array.isArray(row.artifacts) ? [row] : [];
    } catch { return []; /* Interrupted evidence publication cannot stop the health reader. */ }
  });
}
