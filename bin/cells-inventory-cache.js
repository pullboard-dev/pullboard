/** Cache immutable base inventories and incrementally inspect a candidate [C7,D3]. */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { deserialize } from 'node:v8';
import { gzipSync } from 'node:zlib';
import { gunzipSync } from 'node:zlib';
import { cellInventory } from '../packages/codemap/index.js';
import { updateCellInventory } from '../packages/codemap/index.js';
import { receiptDigest } from '../packages/git/index.js';
import { repoInfo } from '../src/git.js';
import { git } from '../src/git.js';
import { Refused } from '../packages/kernel/index.js';

/** A cache is never evidence for a moved or dirty immutable source. */
function unchanged(checkout, commit) {
  if (git(checkout, ['rev-parse', 'HEAD']) !== commit || git(checkout, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Refused('CELLS_SUBMIT', 'immutable analysis snapshot changed during inspection');
  }
}

/** Share only complete immutable inventories under their exact commit and checker identity. */
export function inventoryCache(root, key, parsers, onMode = () => {}, eligible = () => true) {
  const memory = new Map();
  const checker = key ? receiptDigest({ definition: key.checkDigest, preloads: key.config?.preloads }) : null;
  /** Read or construct the pinned base once; a malformed cache is never evidence. */
  function base(checkout, commit) {
    unchanged(checkout, commit);
    if (memory.has(commit)) return memory.get(commit);
    const directory = join(repoInfo(root).commonDir, 'pullboard', 'cells-inventory');
    const file = key ? join(directory, `${receiptDigest({ commit, checker })}.json.gz`) : null;
    let inventory;
    if (file && eligible()) try {
      const data = deserialize(gunzipSync(readFileSync(file), { maxOutputLength: 256 * 1024 * 1024 }));
      if (data.version !== 2 || data.commit !== commit || data.checker !== checker || !Buffer.isBuffer(data.payload)
        || data.digest !== createHash('sha256').update(data.payload).digest('hex')) throw new Error('invalid inventory cache');
      inventory = deserialize(data.payload);
      if (!(inventory.files instanceof Map) || !(inventory.edges instanceof Map) || !Array.isArray(inventory.unknown)
        || [...inventory.files].some(([path, bytes]) => typeof path !== 'string' || !Buffer.isBuffer(bytes))
        || [...inventory.edges].some(([path, rows]) => typeof path !== 'string' || !Array.isArray(rows))
        || inventory.unknown.some(row => !row || typeof row.file !== 'string')) throw new Error('invalid inventory cache');
      if (!eligible()) throw new Error('preload changed');
      unchanged(checkout, commit);
      onMode('base-cache');
    } catch { /* Missing or damaged evidence requires a fresh immutable census. */ }
    if (!inventory) {
      onMode('base-full');
      inventory = cellInventory(checkout, parsers);
      unchanged(checkout, commit);
      if (file && eligible()) try {
        const payload = serialize(inventory);
        const data = { version: 2, commit, checker, digest: createHash('sha256').update(payload).digest('hex'), payload };
        if (!eligible()) throw new Error('preload changed');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `.${randomUUID()}.tmp`);
        writeFileSync(temporary, gzipSync(serialize(data)), { mode: 0o600, flag: 'wx' });
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

/** Persist only complete compiler and lexical observations from checked immutable snapshots. */
export function observationCache(root, key, eligible = () => false) {
  const directory = join(repoInfo(root).commonDir, 'pullboard', 'cells-observations');
  const checker = key ? receiptDigest({ definition: key.checkDigest, preloads: key.config?.preloads }) : null;
  const file = key ? join(directory, `${receiptDigest({ commit: key.config.acceptedMain, checker })}.json.gz`) : null;
  let values = new Map();
  if (file && eligible()) try {
    const data = JSON.parse(gunzipSync(readFileSync(file), { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8'));
    if (data.version !== 1 || data.checker !== checker || data.commit !== key.config.acceptedMain
      || data.digest !== receiptDigest(data.payload)) throw new Error('invalid observations');
    const loaded = deserialize(Buffer.from(data.payload, 'base64'));
    if (!(loaded instanceof Map) || loaded.size > 32768 || [...loaded].some(([id, row]) => typeof id !== 'string'
      || !row || !Number.isSafeInteger(row.bytes) || row.bytes < 0) || !eligible()) throw new Error('invalid observation entries');
    if ([...loaded.values()].reduce((sum, row) => sum + row.bytes, 0) > 128 * 1024 * 1024) throw new Error('oversized observations');
    values = loaded;
  } catch { /* Missing or invalid cache leaves observations empty. */ }
  function commit() {
    if (!file || !eligible()) return;
    try {
      const payload = serialize(values).toString('base64');
      const data = { version: 1, checker, commit: key.config.acceptedMain, digest: receiptDigest(payload), payload };
      if (!eligible()) return;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      writeFileSync(temporary, gzipSync(Buffer.from(JSON.stringify(data))), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } catch { /* Optional observations never replace a real analysis. */ }
  }
  return { values, commit };
}
