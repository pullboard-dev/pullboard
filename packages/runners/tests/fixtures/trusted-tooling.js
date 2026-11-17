/** @pullboard-module-loads packages/runners/index.js */
import { copyRunnerPackage } from './package.js';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = fileURLToPath(new URL('../../../../', import.meta.url));

/** A committed private copy of the runner package, with its own tooling module loaded from that copy so its root is the copy. */
export async function committedTooling(t, graph) {
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  copyRunnerPackage(SOURCE, graph.root);
  graph.commit();
  const { trustedTooling } = await import(pathToFileURL(join(graph.root, 'packages/runners/index.js')).href);
  return { graph, trustedTooling };
}

let shared;

/**
 * The committed private copy, built once for the whole test file; the first call's `t` owns nothing, the file's own `after` removes it.
 * Why: copying, committing and importing the runner package is most of a file's time, and cases that only add one edit to it can start from the same tree [C7].
 *
 * @param {Function} makeGraph - Builds a fixture committed graph; called on the first call only.
 * @returns {Promise<{graph: object, trustedTooling: Function}>} The shared copy.
 */
export function sharedCommittedTooling(makeGraph) {
  shared ??= (async () => {
    const graph = makeGraph();
    return { ...await committedTooling({ after: () => {} }, graph), remove: () => rmSync(graph.root, { recursive: true, force: true }) };
  })();
  return shared;
}
