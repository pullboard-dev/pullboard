#!/usr/bin/env node
/**
 * Rigor check: no synchronous child process inside leased work [C7].
 *
 * A leased job, driver or producer renews its lease on a timer, and `spawnSync`, `execSync` or `execFileSync`
 * blocks the event loop until the child exits, so the timer cannot fire and the lease lapses (three lease losses on
 * 7 Nov: the gate driver, the cells-inventory producer and a blocking test cleanup). This check reads the entry
 * files named in sync-spawn-in-leases.json, follows their relative imports, and flags every call to one of the three
 * in any module reached. Existing calls are listed per file in the same file's baseline, which may only fall:
 * a file that calls more than its baseline allows (an unlisted file allows none) is refused, naming each call site.
 * Strings and comments are masked first, and an `import { spawnSync as run }` alias counts as well.
 *
 * The engine lives in the codemap cell (packages/codemap/src/io/sync-spawn-in-leases.js); this launcher runs it from
 * the command line (`--report`, `--write`, or the check by default) and when a caller imports it.
 *
 * @file-local Reads the config and the modules reached from its entries, through the engine.
 */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncCallsIn } from '../../../../codemap/index.js';
import { syncSpawnProblems } from '../../../../codemap/index.js';
import { syncSpawnReport } from '../../../../codemap/index.js';
import { writeSyncSpawnBaseline } from '../../../../codemap/index.js';
import { report } from '../scan.js';
import { runCheck } from '../scan.js';

export { syncCallsIn, syncSpawnProblems, syncSpawnReport, writeSyncSpawnBaseline };

const fs = fileSystemAdapter();
const MAIN = Boolean(process.argv[1]) && fs.exists(process.argv[1]) && fs.realpath(process.argv[1]) === fs.realpath(fileURLToPath(import.meta.url));

if (MAIN && process.argv.includes('--report')) {
  const root = resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? '.');
  const counts = {};
  for (const [path, { lines }] of Object.entries(syncSpawnReport(root))) counts[path] = lines.length;
  console.log(JSON.stringify(counts, null, 2));
} else if (MAIN && process.argv.includes('--write')) {
  report(writeSyncSpawnBaseline(resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? '.')));
} else runCheck(import.meta, syncSpawnProblems);
