/** Detached entry that builds one stress board cache and then drops its lock [N26]. */
import { rmSync } from 'node:fs';
import { buildStressCache } from './stress-cache.mjs';

const [inputs, cache, lock] = process.argv.slice(2);
try { buildStressCache(JSON.parse(inputs), cache); } finally { rmSync(lock, { recursive: true, force: true }); }
