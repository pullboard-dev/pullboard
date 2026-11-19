import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
} from 'node:path';
import { Refused } from '../../../../../packages/kernel/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/**
 * Refuse a worktree folder inside the operating system's temporary directory, naming the persistent default.
 * Why: the system may clear that directory with a seat's unsubmitted work in it [#8513].
 *
 * @param {string} folder - where the seat folder would be made
 * @param {{ worktrees?: string }} config
 */
export function refuseUnderTemp(folder, config) {
  const real = (path) => { try { return fs.realpath(path); } catch { return path; } };
  const temp = real(tmpdir());
  const rel = relative(temp, join(real(dirname(folder)), basename(folder)));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return;
  throw new Refused('TEMP_WORKTREE', `${folder} is under the temporary directory ${temp}, which the system may clear with the work in it; the persistent default is the "${config.worktrees ?? 'beside'}" placement next to a project kept outside it ("worktrees" in pullboard.json)`);
}
