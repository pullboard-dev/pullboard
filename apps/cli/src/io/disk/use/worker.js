/**
 * The detached measurement status starts: walk the board's stores once, write the disk-use cache, and free the lock,
 * so no board command ever waits on the walk [C7].
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { MEASURE_LOCK } from '../use.js';
import { diskUse } from '../use.js';

const dir = process.argv[2];
try { diskUse(dir, { now: Date.now() }); } catch { /* A bad policy file or a vanished board leaves the cache as it was. */ }
finally { rmSync(join(dir, MEASURE_LOCK), { force: true }); }
