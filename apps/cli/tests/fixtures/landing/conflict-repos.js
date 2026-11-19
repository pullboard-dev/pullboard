/** Real temp repos where main and one item head conflict only mechanically, or for real, for landing-offer tests [C7,#3064]. */
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';

const SHARD_FILE = 'packages/codemap/data/plan/14-state.json';
const SOURCE_FILE = 'src/shared.js';
const row = n => `["src/m-${n}.js","packages/state/src/m-${n}.js","rule"]`;
/** A cells-plan shard in the plan writer's layout: one row per line. */
const shard = numbers => `{\n "order": 8,\n "name": "state",\n "paths": [\n${numbers.map(row).map(line => `  ${line}`).join(',\n')}\n ]\n}\n`;

/** One repo on main: a base commit, then the item head (own branch) and main each commit their version of `file`. */
function diverge(file, base, mainText, itemText) {
  const files = privateFixtureFiles('pb-conflict-repos-');
  files.write(file, base);
  fixtureCommitAll(files.root);
  const git = (...args) => runFixtureSetupGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: files.root });
  const commit = (branch, text) => {
    files.write(file, text);
    git('commit', '-q', '-am', branch);
    return git('rev-parse', 'HEAD');
  };
  git('checkout', '-q', '-b', 'item');
  const head = commit('item', itemText);
  git('checkout', '-q', 'main');
  const main = commit('main', mainText);
  return { root: files.root, main, head, file };
}

/** Main and the item head each append a different row to one cells-plan shard: git alone conflicts, the mechanical merge does not. */
export function mechanicalOnlyConflictRepo() {
  return diverge(SHARD_FILE, shard([1, 2]), shard([1, 2, 3]), shard([1, 2, 4]));
}

/** Main and the item head change the same line of one source file: a conflict no mechanical rule resolves. */
export function realConflictRepo() {
  const text = value => `export const limit = ${value};\nexport const other = 1;\n`;
  return diverge(SOURCE_FILE, text(1), text(2), text(3));
}
