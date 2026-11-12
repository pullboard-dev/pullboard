/**
 * A spawn counter for speed tests [C7]. Started with `--import`, it logs each child process the process starts, and
 * every process that inherits NODE_OPTIONS, to the file named by PULLBOARD_SPAWN_LOG, one line per child:
 * `<pid> <api> <command> <first two args>`. A test reads the log back with `spawnCounts`.
 * Why: a command's spawn count is the cost the speed pieces cut; the count is stable where milliseconds are not.
 */
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';

const LOG = process.env.PULLBOARD_SPAWN_LOG;
const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec'];

if (LOG) {
  for (const api of APIS) {
    const real = childProcess[api];
    childProcess[api] = function recorded(...args) {
      const command = typeof args[0] === 'string' ? args[0].trim().split(/\s+/u)[0] : '';
      const rest = Array.isArray(args[1]) ? args[1] : typeof args[0] === 'string' ? args[0].trim().split(/\s+/u).slice(1) : [];
      appendFileSync(LOG, `${process.pid} ${api} ${command} ${rest.slice(0, 2).join(' ')}\n`);
      return real.apply(this, args);
    };
  }
  syncBuiltinESMExports();
}

/** The environment that makes a child CLI log its spawns to `file`, and its descendants too. */
export function spawnEnv(file) {
  return { PULLBOARD_SPAWN_LOG: file, NODE_OPTIONS: `--import=${pathToFileURL(import.meta.filename).href}` };
}

/** The logged children as `{ git, node, other, total }`, counting every command in `file` since it was last cleared. */
export function spawnCounts(file) {
  const counts = { git: 0, node: 0, other: 0, total: 0 };
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* No child was started. */ }
  for (const line of text.split('\n').filter(Boolean)) {
    const name = basename(line.split(' ')[2] ?? '');
    counts[name === 'git' ? 'git' : name === 'node' ? 'node' : 'other'] += 1;
    counts.total += 1;
  }
  return counts;
}
