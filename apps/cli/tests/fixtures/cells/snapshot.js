/** A main repository and a candidate repository that differ only by one edit, in the cells plan layout the submit check reads [C7,#10939]. */
import { rmSync } from 'node:fs';
import { fixtureCommittedGraph } from '../../../../../packages/gate/tests/fixtures/testkit.js';

const PLAN = 'packages/codemap/data/plan';
const SHARD = `${PLAN}/01-demo.json`;
const SOURCE = 'packages/demo/index.js';

/** The plan files and the one planned source file both repositories hold. */
function planFiles() {
  const index = { version: 1, names: {}, cells: [{ order: 1, name: 'demo', file: SHARD }], stays: [], retired: [], entries: [], engineStays: [], allowedEdges: [], upwardEdgesGrandfathered: [] };
  const shard = { order: 1, name: 'demo', kind: 'package', root: 'packages/demo', frontDoor: SOURCE, paths: [], reexports: [], imports: [], cuts: [] };
  return {
    [`${PLAN}/cells.json`]: JSON.stringify(index, null, 2) + '\n',
    'pullboard.json': JSON.stringify({ cells: { cache: true, plan: `${PLAN}/cells.json` } }, null, 2) + '\n',
    [SHARD]: JSON.stringify(shard, null, 1) + '\n',
    [SOURCE]: "export const demo = 'demo';\n",
  };
}

/**
 * Two committed temporary repositories, main and candidate, each with cells.json, one numbered shard and one planned source file.
 * The candidate differs from main only by what `edit` writes through `put(path, body)`; both folders are removed after the test.
 *
 * @param {{ after: Function }} t - The running test, for cleanup.
 * @param {(put: (path: string, body: string) => void) => void} [edit] - The candidate's one change.
 * @returns {{ main: { root: string, commit: string }, candidate: { root: string, commit: string } }}
 */
export function cellsSnapshotPair(t, edit = () => {}) {
  const build = prefix => {
    const graph = fixtureCommittedGraph(prefix);
    t.after(() => rmSync(graph.root, { recursive: true, force: true }));
    for (const [path, body] of Object.entries(planFiles())) graph.put(path, body);
    return graph;
  };
  const main = build('pullboard-cells-main-');
  const mainCommit = main.commit();
  const candidate = build('pullboard-cells-candidate-');
  edit(candidate.put);
  return { main: { root: main.root, commit: mainCommit }, candidate: { root: candidate.root, commit: candidate.commit() } };
}
