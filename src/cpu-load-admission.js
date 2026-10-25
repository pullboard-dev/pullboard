/** CPU-load declarations are source metadata; discovery never executes test code [C7]. */
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { loadMachineSettings } from './settings.js';
import { cpuLoadOptionsIn } from './module-imports.js';
import { importsIn } from './module-imports.js';

const MAX_FILES = 256;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 32;

/** Inspect a bounded executable module closure; uncertainty is conservative placement, never code evaluation. */
export function testsNeedCpuRunner(root, files) {
  try {
    const boundary = realpathSync(root);
    const pending = files.map(file => ({ path: resolve(boundary, file), depth: 0 }));
    const seen = new Set();
    let bytes = 0;
    while (pending.length) {
      const { path, depth } = pending.pop();
      const actual = realpathSync(path);
      const within = relative(boundary, actual);
      if (within === '..' || within.startsWith(`..${sep}`) || resolve(boundary, within) !== actual) return true;
      if (seen.has(actual)) continue;
      if (depth > MAX_DEPTH) return true;
      seen.add(actual);
      const info = statSync(actual);
      bytes += info.size;
      if (!info.isFile() || seen.size > MAX_FILES || bytes > MAX_BYTES) return true;
      // JSON imports supply data without an executable registration body; still enforce closure containment.
      if (actual.endsWith('.json')) continue;
      if (!/\.(?:[cm]?js)$/u.test(actual)) return true;
      const source = readFileSync(actual, 'utf8');
      if (cpuLoadOptionsIn([source])[0]) return true;
      for (const name of importsIn([source])[0]) {
        if (isBuiltin(name)) continue;
        if (!name.startsWith('./') && !name.startsWith('../')) return true;
        pending.push({ path: resolve(dirname(actual), name), depth: depth + 1 });
      }
    }
    return false;
  } catch {
    // Missing, unreadable or unparseable closure metadata cannot prove ordinary local work.
    return true;
  }
}

/** Report the explicit no-runner fallback while keeping registered CPU work off the coordinator. */
export function cpuRunnerRequired(root, files) {
  const declared = testsNeedCpuRunner(root, files);
  const registered = (loadMachineSettings().runners ?? []).length > 0;
  if (declared && !registered) process.stderr.write('CPU-load test uses the current admitted slot because no runners are registered\n');
  return declared && registered;
}
