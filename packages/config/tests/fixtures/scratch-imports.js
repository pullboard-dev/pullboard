/** Observes the real cold import graph of one config module in a child process before inherited preloads [C7]. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Load `entry` in a fresh node process whose resolve and load hooks run before any inherited preload, then return its reachable file closure. */
/** `files` is a private fixture folder the caller owns (privateFixtureFiles). */
export function observeColdClosure(entry, files) {
  files.write('observe.mjs', `
import { registerHooks } from 'node:module';
const edges = [];
const loaded = new Set();
globalThis.pullboardScratchImportObservation = { edges, loaded };
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    edges.push([context.parentURL ?? null, result.url]);
    return result;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    loaded.add(url);
    return result;
  },
});
`);
  const observer = pathToFileURL(join(files.root, 'observe.mjs')).href;
  const env = { ...process.env, NODE_OPTIONS: `--import=${observer} ${process.env.NODE_OPTIONS ?? ''}` };
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
await import(${JSON.stringify(entry)});
const { edges, loaded } = globalThis.pullboardScratchImportObservation;
process.stdout.write(JSON.stringify({ edges, loaded: [...loaded] }));
`], { encoding: 'utf8', env });
  if (run.status !== 0 || run.signal !== null) throw new Error(`cold import child failed: ${String(run.stderr).slice(-2000)}`);
  const observed = JSON.parse(run.stdout);
  const reachable = new Set([entry]);
  let size;
  do {
    size = reachable.size;
    for (const [parent, child] of observed.edges) if (reachable.has(parent) && child.startsWith('file:')) reachable.add(child);
  } while (size !== reachable.size);
  return { loaded: observed.loaded, reachable: [...reachable].sort() };
}
