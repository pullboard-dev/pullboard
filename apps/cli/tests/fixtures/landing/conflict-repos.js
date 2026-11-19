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

/** The file and the three texts of the mechanical-only conflict: the base, main's version and the item head's version, each appending a different plan row. */
export function mechanicalOnlyConflictTexts() {
  return { file: SHARD_FILE, base: shard([1, 2]), main: shard([1, 2, 3]), item: shard([1, 2, 4]) };
}

/** The file and the three texts of the real conflict: main and the item head change the same line of one source file. */
export function realConflictTexts() {
  const text = value => `export const limit = ${value};\nexport const other = 1;\n`;
  return { file: SOURCE_FILE, base: text(1), main: text(2), item: text(3) };
}

/** Main and the item head each append a different row to one cells-plan shard: git alone conflicts, the mechanical merge does not. */
export function mechanicalOnlyConflictRepo() {
  const { file, base, main, item } = mechanicalOnlyConflictTexts();
  return diverge(file, base, main, item);
}

/** Main and the item head change the same line of one source file: a conflict no mechanical rule resolves. */
export function realConflictRepo() {
  const { file, base, main, item } = realConflictTexts();
  return diverge(file, base, main, item);
}
