/** Submit's edge stage: the import edges a diff adds, listed only when submit.edgeFollowUps is on [C7]. */
import { posix } from 'node:path';
import { importsIn } from '../../../codemap/index.js';
import { tryGit } from '../../../git/index.js';
import { addedImportEdges } from '../logic/import-edges.js';

const MODULE = /\.[cm]?js$/u;

/** The import graph of the changed modules at one revision: { importer: [resolved relative targets] }. */
function graphAt(root, rev, files) {
  const present = files.filter(file => tryGit(root, ['cat-file', '-e', `${rev}:${file}`]).status === 0);
  const sources = present.map(file => tryGit(root, ['show', `${rev}:${file}`]).stdout);
  const imports = importsIn(sources);
  const graph = {};
  present.forEach((file, index) => {
    graph[file] = imports[index].filter(spec => spec.startsWith('.')).map(spec => posix.normalize(posix.join(posix.dirname(file), spec)));
  });
  return graph;
}

/**
 * The import edges the diff from `base` to `commit` adds, as sorted { from, to } rows; empty, and git untouched, when
 * submit.edgeFollowUps is off. Why: slice 1 only computes them, so a later slice can file follow-ups from the list [C7].
 *
 * @param {string} root - The checkout to read git from.
 * @param {{ submit?: { edgeFollowUps?: boolean } }} config
 * @param {{ base: string, commit?: string }} range
 * @returns {{ from: string, to: string }[]}
 */
export function submitImportEdges(root, config, { base, commit = 'HEAD' }) {
  if (config.submit?.edgeFollowUps !== true) return [];
  const diff = tryGit(root, ['diff', '--name-only', '--diff-filter=AMR', `${base}..${commit}`]);
  const files = diff.stdout.split('\n').filter(file => MODULE.test(file));
  if (!files.length) return [];
  return addedImportEdges(graphAt(root, base, files), graphAt(root, commit, files));
}
