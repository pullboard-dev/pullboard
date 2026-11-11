/** Read literal module edges for the explicit Chrome GUI annotation guard without running any source [C7,V4]. */
import { readFileSync } from 'node:fs';
import {
  posix,
  resolve,
} from 'node:path';
import { importsIn } from '../../index.js';

const LAUNCHERS = new Set(['apps/cli/tests/fixtures/chrome.js', 'apps/cli/tests/fixtures/chrome/args.js', 'apps/cli/tests/fixtures/cockpit/harness.js']);

/** Find one literal in-repository module among the tracked paths; fixture strings are not import edges. */
function localModule(files, importer, request) {
  if (!request.startsWith('.')) return null;
  const path = posix.normalize(posix.join(posix.dirname(importer), request.split(/[?#]/u)[0]));
  if (path.startsWith('../')) return null;
  return [path, ...['.js', '.mjs', '.cjs'].map(extension => path + extension)]
    .find(candidate => files.has(candidate)) ?? null;
}

/** Return every tracked test whose literal import graph reaches a shared Chrome launcher, conservatively including helper-only bindings. */
export function chromeLaunchingTests(root, tracked) {
  const files = new Set(tracked);
  const tests = tracked.filter(file => /\.test\.[cm]?js$/u.test(file));
  const graph = new Map();
  let frontier = tests;
  while (frontier.length) {
    const paths = [...new Set(frontier)].filter(path => !graph.has(path));
    frontier = [];
    for (let index = 0; index < paths.length; index += 64) {
      const batch = paths.slice(index, index + 64);
      const sources = batch.map(path => readFileSync(resolve(root, path), 'utf8'));
      const edges = importsIn(sources);
      batch.forEach((path, offset) => {
        const local = edges[offset].map(request => localModule(files, path, request))
          .filter(target => target && /\.[cm]?js$/u.test(target));
        graph.set(path, local);
        frontier.push(...local);
      });
    }
  }
  /** Walk already parsed edges with per-test cycle protection; no target source is evaluated. */
  function reachesLauncher(path, seen = new Set()) {
    if (LAUNCHERS.has(path)) return true;
    if (seen.has(path)) return false;
    seen.add(path);
    return (graph.get(path) ?? []).some(target => reachesLauncher(target, seen));
  }
  return tests.filter(path => reachesLauncher(path)).sort();
}
