/** Runs the edges command line on a fixture tree and returns its exit status, so a cell test never launches a node child itself [C7]. */
import { fileURLToPath } from 'node:url';
import { runFixtureChild } from './child.js';

const EDGES = fileURLToPath(new URL('../../src/io/edges.js', import.meta.url));

/** The exit status of edges.js on a root with the given flags. */
export function edgesExitStatus(root, ...flags) {
  return runFixtureChild(process.execPath, [EDGES, root, ...flags], { encoding: 'utf8' }).status;
}
