/**
 * The pullboard main-red-files command: the coordinator prints, replaces or clears the gate's main-red file list, board
 * meta gate_main_red_files, a JSON array of repo-relative paths. Why: the gate settle counts a file on that list as red
 * on main (#12130), and until now the coordinator edited SQLite by hand to change it [C7,#12133].
 */
import * as store from '../../../../../packages/store/index.js';
import {
  COORDINATOR,
} from '../../../../../packages/config/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  actOn,
} from '../entry.js';

/** The board meta key the gate settle reads (packages/api/src/io/gate/main-red-files.js names it MAIN_RED_FILES_KEY). */
const MAIN_RED_FILES_KEY = 'gate_main_red_files';

const USAGE = 'pullboard main-red-files [set <path> [<path> ...] | --clear]';

/** Why `file` is not a repo-relative path, or null when it is one. */
function badPath(file) {
  if (!file) return 'is empty';
  if (/[\0\n\r]/u.test(file)) return 'holds a newline or NUL';
  if (file.startsWith('/')) return 'is absolute';
  if (file.split('/').some(segment => segment === '.' || segment === '..')) return 'has a . or .. segment';
  return null;
}

/** The list as stored; empty when unset or unreadable. */
function storedList(board) {
  let value = null;
  try { value = JSON.parse(store.readBoardMeta(board.db, MAIN_RED_FILES_KEY) ?? 'null'); } catch { value = null; }
  return Array.isArray(value) ? value.filter(file => typeof file === 'string') : [];
}

/** Run `pullboard main-red-files` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const paths = [second, ...(rest ?? [])].filter(part => part !== undefined);
  if (values.clear ? first !== undefined : first !== undefined && first !== 'set') throw new Refused('USAGE', `give ${USAGE}`);
  if (first === 'set' && !paths.length) throw new Refused('USAGE', `name at least one path: ${USAGE}`);
  return actOn(io, async (ctx, board, me) => {
    if (me.id !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator writes the main-red file list');
    if (first === 'set' || values.clear) {
      for (const file of paths) {
        const why = badPath(file);
        if (why) throw new Refused('USAGE', `${JSON.stringify(file)} ${why}; give repo-relative paths`);
      }
      const files = values.clear ? [] : [...new Set(paths)].sort();
      store.writeBoardMeta(board.db, MAIN_RED_FILES_KEY, JSON.stringify(files));
      io.result?.({ files });
      io.say(files.length ? `main-red files: ${files.length} listed` : 'main-red files cleared');
      return 0;
    }
    const files = storedList(board);
    io.result?.({ files });
    for (const file of files) io.say(file);
    return 0;
  });
}
