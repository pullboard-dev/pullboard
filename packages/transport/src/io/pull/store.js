/** A file-backed store for the pull adapter, so offers and registrations survive a board restart [C7]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

/** The file, inside the board folder, that holds the pull adapter's registrations, offers and spent take nonces. */
export const PULL_STORE_FILE = 'pull.json';

/**
 * A pull store kept in one JSON file, replaced whole by rename so a crash never leaves half a file.
 *
 * Why: a restart that forgot the offered jobs would leave every runner polling an empty book until the gate re-offered.
 *
 * @param {string} path
 * @returns {{ load: () => (object | null), save: (state: object) => void }}
 */
export function fileStore(path) {
  return {
    /** The saved state, or null when none was saved yet or the file cannot be read as JSON. */
    load() {
      if (!existsSync(path)) return null;
      try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
    },
    /** Replace the saved state. */
    save(state) {
      const next = `${path}.${process.pid}.tmp`;
      writeFileSync(next, JSON.stringify(state), { mode: 0o600 });
      renameSync(next, path);
    },
  };
}
