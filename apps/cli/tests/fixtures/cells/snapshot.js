/** A main repository and a candidate repository that differ only by one edit, in the cells plan layout the submit check reads [C7,#10939]. */
import { rmSync } from 'node:fs';
import { runFixtureGit } from '../child.js';
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
 * Two isolated temporary repositories sharing the actual accepted commit, with cells.json, one shard and one source file.
 * Fetch the accepted object before editing; an unchanged candidate stays there and an edit creates its descendant.
 * The candidate differs only by what `edit` writes through `put(path, body)`; both folders are removed after the test.
 *
 * @param {{ after: Function }} t - The running test, for cleanup.
 * @param {(put: (path: string, body: string) => void) => void} [edit] - The candidate's one change.
 * @param {{ mainDate?: string, candidateDate?: string }} [dates] - Distinct controlled commit dates expose unrelated histories without waiting.
 * @returns {{ main: { root: string, commit: string }, candidate: { root: string, commit: string } }}
 */
export function cellsSnapshotPair(t, edit = () => {}, { mainDate = '2020-01-01T00:00:00Z', candidateDate = '2020-01-02T00:00:00Z' } = {}) {
  const build = prefix => {
    const graph = fixtureCommittedGraph(prefix);
    t.after(() => rmSync(graph.root, { recursive: true, force: true }));
    for (const [path, body] of Object.entries(planFiles())) graph.put(path, body);
    return graph;
  };
  /** Commit real staged files at the supplied date, keeping an edit's date distinct from its accepted parent. */
  const commit = (graph, date) => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const git = (...args) => runFixtureGit(args, { cwd: graph.root, env });
    git('add', '-A');
    git('commit', '-qm', 'chore: fixture graph');
    return git('rev-parse', 'HEAD');
  };
  const main = build('pullboard-cells-main-');
  const mainCommit = commit(main, mainDate);
  const candidate = build('pullboard-cells-candidate-');
  const git = (...args) => runFixtureGit(args, { cwd: candidate.root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('fetch', '--quiet', '--no-tags', main.root, mainCommit);
  git('reset', '--quiet', '--hard', mainCommit);
  edit(candidate.put);
  const candidateCommit = git('status', '--porcelain') ? commit(candidate, candidateDate) : mainCommit;
  return { main: { root: main.root, commit: mainCommit }, candidate: { root: candidate.root, commit: candidateCommit } };
}
