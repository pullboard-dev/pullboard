/** The source ceiling tables whose rows a lane may move between its own files, each path from its owning module [L3,C7]. */
import { CELLS_EDGES_CEILINGS } from '../edges.js';
import { CLOCK_CEILING_FILE } from '../adapter-lints/clock.js';
import { FS_CEILING_FILE } from '../adapter-lints/fs.js';
import { SSH_CEILING_FILE } from '../adapter-lints/ssh.js';
import { GITHUB_CEILING_FILE } from '../adapter-lints/github.js';
import { LOAD_BEARING_CEILINGS } from '../../logic/load/bearing.js';
import { STORE_BASELINE } from '../stores.js';

/**
 * The per-file source ceiling tables whose rows a lane may move between its own files in one commit when no rule's
 * total rises, each named by the module that owns it, with its row shape: `files` keeps the rows under that key and
 * `bare` rows are plain counts. The pre-commit hands this to the commits cell's lane check, so no path is spelled twice
 * (coordinator ruling 17 Nov, #10242) [L3,C7].
 */
export const CEILING_ROW_TABLES = Object.freeze({
  [LOAD_BEARING_CEILINGS]: Object.freeze({}),
  [STORE_BASELINE]: Object.freeze({}),
  [CLOCK_CEILING_FILE]: Object.freeze({ files: true, bare: true }),
  [FS_CEILING_FILE]: Object.freeze({ files: true, bare: true }),
  [SSH_CEILING_FILE]: Object.freeze({ files: true, bare: true }),
  [GITHUB_CEILING_FILE]: Object.freeze({ files: true, bare: true }),
  [CELLS_EDGES_CEILINGS]: Object.freeze({ files: true }),
});

/** The cells-edges table's split check, kept beside the table shapes so the hook reads both from one module [L3,C7]. */
export { splitRowCovered } from './split.js';
