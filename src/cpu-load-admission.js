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
import { cpuRegistrationExportsIn } from './module-imports.js';
import { cpuCallableExportsIn } from './module-imports.js';
import { importsIn } from './module-imports.js';

const MAX_FILES = 256;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 32;

/** Inspect bounded readable imports for explicit CPU declarations; uncertainty is not a declaration [C7]. */
export function testsNeedCpuRunner(root, files) {
  const entries = [];
  try {
    const boundary = realpathSync(root);
    const pending = files.map(file => ({ path: resolve(boundary, file), depth: 0 }));
    const seen = new Set();
    let bytes = 0;
    while (pending.length) {
      const batch = pending.splice(0);
      const readable = [];
      for (const { path, depth } of batch) {
        let actual;
        try { actual = realpathSync(path); } catch { continue; }
        const within = relative(boundary, actual);
        if (within === '..' || within.startsWith(`..${sep}`) || seen.has(actual) || depth > MAX_DEPTH) continue;
        seen.add(actual);
        const info = statSync(actual);
        bytes += info.size;
        if (seen.size > MAX_FILES || bytes > MAX_BYTES) break;
        if (!info.isFile() || !/\.(?:[cm]?js)$/u.test(actual)) continue;
        const entry = { path: actual, source: readFileSync(actual, 'utf8') };
        entries.push(entry);
        readable.push({ entry, depth });
      }
      const edges = importsIn(readable.map(({ entry }) => entry.source));
      for (const [index, { entry, depth }] of readable.entries()) {
        for (const name of edges[index]) {
          if (!isBuiltin(name) && (name.startsWith('./') || name.startsWith('../'))) {
            pending.push({ path: resolve(dirname(entry.path), name), depth: depth + 1 });
          }
        }
      }
      if (seen.size > MAX_FILES || bytes > MAX_BYTES) break;
    }
  } catch { /* Unreadable ordinary code cannot invent CPU authority; retain the readable prefix. */ }
  const sources = entries.map(entry => entry.source);
  const literalCache = new Map();
  const exports = new Map(entries.map(entry => [entry.path, new Set()]));
  const callables = new Map(entries.map(entry => [entry.path, new Set()]));
  const resolveExports = table => (index, name) => {
    if (typeof name !== 'string' || !name.startsWith('.')) return new Set();
    return table.get(resolve(dirname(entries[index].path), name)) ?? new Set();
  };
  const imported = resolveExports(exports);
  const importedCallables = resolveExports(callables);
  // Propagate registration authority and callable evidence separately in the same bounded graph.
  for (let pass = 0; pass < entries.length; pass++) {
    const next = cpuRegistrationExportsIn(sources, imported, literalCache);
    const nextCallables = cpuCallableExportsIn(sources, importedCallables, literalCache);
    let changed = false;
    for (const [index, entry] of entries.entries()) for (const name of next[index]) {
      const names = exports.get(entry.path);
      if (!names.has(name)) { names.add(name); changed = true; }
    }
    for (const [index, entry] of entries.entries()) for (const name of nextCallables[index]) {
      const names = callables.get(entry.path);
      if (!names.has(name)) { names.add(name); changed = true; }
    }
    if (!changed) break;
  }
  return cpuLoadOptionsIn(sources, imported, importedCallables, literalCache).some(Boolean);
}

/** Report the explicit no-runner fallback while keeping registered CPU work off the coordinator. */
export function cpuRunnerRequired(root, files) {
  const declared = testsNeedCpuRunner(root, files);
  const registered = (loadMachineSettings().runners ?? []).length > 0;
  if (declared && !registered) process.stderr.write('CPU-load test uses the current admitted slot because no runners are registered\n');
  return declared && registered;
}
