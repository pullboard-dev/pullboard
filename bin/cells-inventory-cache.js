/** Cache immutable base inventories and incrementally inspect a candidate [C7,D3]. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { gunzipSync } from 'node:zlib';
import { cellInventory } from '../packages/codemap/index.js';
import { updateCellInventory } from '../packages/codemap/index.js';
import { receiptDigest } from '../packages/git/index.js';
import { repoInfo } from '../src/git.js';

/** Share only complete immutable inventories under their exact commit and checker identity. */
export function inventoryCache(root, key, parsers, onMode = () => {}) {
  const memory = new Map();
  const checker = key ? receiptDigest({ definition: key.checkDigest, preloads: key.config?.preloads }) : null;
  /** Read or construct the pinned base once; a malformed cache is never evidence. */
  function base(checkout, commit) {
    if (memory.has(commit)) return memory.get(commit);
    const directory = join(repoInfo(root).commonDir, 'pullboard', 'cells-inventory');
    const file = key ? join(directory, `${receiptDigest({ commit, checker })}.json.gz`) : null;
    let inventory;
    if (file) try {
      const data = JSON.parse(gunzipSync(readFileSync(file), { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8'));
      if (data.version !== 1 || data.commit !== commit || data.checker !== checker || data.digest !== receiptDigest(data.payload)) throw new Error('invalid inventory cache');
      inventory = { files: new Map(data.payload.files.map(([path, bytes]) => [path, Buffer.from(bytes, 'base64')])),
        edges: new Map(data.payload.edges), unknown: data.payload.unknown };
      if (!Array.isArray(data.payload.files) || !Array.isArray(data.payload.edges) || !Array.isArray(inventory.unknown)) throw new Error('invalid inventory cache');
      onMode('base-cache');
    } catch { /* Missing or damaged evidence requires a fresh immutable census. */ }
    if (!inventory) {
      onMode('base-full');
      inventory = cellInventory(checkout, parsers);
      if (file) try {
        const payload = { files: [...inventory.files].map(([path, bytes]) => [path, bytes.toString('base64')]), edges: [...inventory.edges], unknown: inventory.unknown };
        const data = { version: 1, commit, checker, digest: receiptDigest(payload), payload };
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `.${randomUUID()}.tmp`);
        writeFileSync(temporary, gzipSync(Buffer.from(JSON.stringify(data))), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
      } catch { /* A cache write failure only costs a later census. */ }
    }
    memory.set(commit, inventory);
    return inventory;
  }
  /** Update only changed existing files; unsupported structural changes keep the canonical fallback. */
  function candidate(checkout, prior, changed) {
    const fallback = changed.some(file => file === 'package.json' || file === 'packages/kernel/index.js'
      || file.endsWith('/discovery.js') || !prior.files.has(file)
      || !existsSync(join(checkout, file)) || !lstatSync(join(checkout, file)).isFile());
    onMode(fallback ? 'candidate-full-fallback' : 'candidate-incremental');
    return fallback ? cellInventory(checkout, parsers) : updateCellInventory(checkout, parsers, prior, changed);
  }
  return { base, candidate };
}
