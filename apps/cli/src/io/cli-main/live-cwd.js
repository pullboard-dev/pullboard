import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The checkout a command should run in when its working directory has been removed.
 *
 * What: a release ends a claim and cleanup removes the item folder the agent's shell stands in; the
 * shell's next `pullboard next` then starts in a path that is gone. The seat's own checkout sits
 * beside the folder (`<seat>-item-<id>`), so that is where the command belongs [B5,N2].
 * Why: a missing directory made the chained next fail with ENOENT uv_cwd (#2456), though the seat was fine.
 *
 * @param {string} gone - The working directory that no longer exists.
 * @returns {string|null} The seat checkout, else the nearest surviving parent, else null.
 */
export function survivingDirectory(gone) {
  const seat = /^(.+)-item-[1-9][0-9]*$/u.exec(gone)?.[1];
  if (seat && existsSync(seat)) return seat;
  for (let dir = dirname(gone); dir !== dirname(dir); dir = dirname(dir)) if (existsSync(dir)) return dir;
  return null;
}

/**
 * The working directory a command runs in: the one it was given, or its surviving seat checkout.
 *
 * @param {string|undefined} given - The directory the caller passed, if any.
 * @param {{ cwd: () => string, env: Record<string, string|undefined>, chdir: (dir: string) => void }} [process_] - The process's own view, replaceable in tests.
 * @returns {string} A directory that exists.
 */
export function liveCwd(given, process_ = { cwd: () => process.cwd(), env: process.env, chdir: dir => process.chdir(dir) }) {
  let wanted = given;
  if (wanted === undefined) {
    try { return process_.cwd(); } catch { wanted = process_.env.PWD; }
  }
  if (wanted === undefined || existsSync(wanted)) return wanted ?? process_.cwd();
  const alive = survivingDirectory(wanted);
  if (alive === null) return wanted;
  if (given === undefined) process_.chdir(alive);
  return alive;
}
