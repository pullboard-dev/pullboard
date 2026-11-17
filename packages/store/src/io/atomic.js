/** The one writer of a state file: whole bytes appear by rename, never half of them; the store owns it, its only user [C7,CD31]. */
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

/**
 * Write a file's whole content to a unique temporary sibling, then rename it over the target, so a reader sees the old
 * bytes or the new, never a torn file. A failed write or rename removes the temporary sibling and leaves the target as it was.
 * Why one writer: fifty-odd private copies each decided mode, cleanup and error handling alone [C7].
 *
 * @param {string} file - The target path; its folder must exist.
 * @param {string | Uint8Array} data - The whole new content.
 * @param {{ mode?: number }} [options] - The file mode for the new file, 0o600 by default (a state file is private).
 * @returns {void}
 */
export function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
