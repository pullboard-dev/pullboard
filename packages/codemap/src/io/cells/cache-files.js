/** The cells cache directory and atomic publish helpers, apart from the inventory logic that uses them [C7]. */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processMachineHome } from '../../../../kernel/light.js';

/** How many inventories or observation sets one machine keeps per kind; older entries leave by last use. */
const KEEP = 24;

/**
 * The machine-level folder for one kind of cells cache. Why the machine and not the checkout's Git directory: every
 * runner job is a fresh checkout, so a cache beside it never survived to the next job and each gate rebuilt main's
 * whole inventory (#2531). Entries are keyed by commit and checker digest, so repositories and jobs share safely.
 */
export function cellsCacheDirectory(kind) { return join(processMachineHome(), 'cells-cache', kind); }

/** Atomically publish one cache entry, then keep only the most recently used entries of its kind. */
export function publishCacheEntry(directory, file, bytes) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  try {
    const entries = readdirSync(directory).filter(name => name.endsWith('.json.gz')).map(name => {
      try { return { name, used: statSync(join(directory, name)).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.used - a.used);
    for (const entry of entries.slice(KEEP)) rmSync(join(directory, entry.name), { force: true });
  } catch { /* Pruning failure only costs disk until the next write. */ }
}
