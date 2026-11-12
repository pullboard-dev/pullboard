/** New shim dependencies fail before a full gate, while exact old imports retain their allowance [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shimImportProblems } from '../../../../packages/codemap/index.js';
import { stagedShimImportProblems } from '../../../../packages/codemap/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixturePolicy } from '../../tests/fixtures/testkit.js';

const PLAN = { cells: [{ order: 1, name: 'git', root: 'packages/git', frontDoor: 'packages/git/index.js',
  paths: [['src/git.js', 'packages/git/src/shell/git.js', 'seed']] }] };
const FILES = new Map([
  ['src/git.js', "export { git } from '../packages/git/index.js';\n"],
  ['packages/git/index.js', "export { git } from './src/shell/git.js';\n"],
  ['packages/git/src/shell/git.js', 'export const git = 1;\n'],
]);

/** Supply immutable source snapshots to the exact shared policy used by hooks and the gate. */
function problems({ before = '', after, extra = new Map(), criterion = '', file = 'src/use.js' }) {
  return shimImportProblems({ plans: [PLAN], parseImports: importsIn, criterion,
    read: (revision, name) => extra.get(name) ?? FILES.get(name),
    changes: [{ file, before, after }] });
}

test('new shim imports name the front door; unchanged imports and new front-door imports pass [C7,CD64]', () => {
  const old = "import { git } from './git.js';\n";
  assert.match(problems({ after: old })[0], /src\/use.js:1:.*src\/git.js.*packages\/git\/index.js/u);
  assert.deepEqual(problems({ before: old, after: old + 'export const value = git;\n' }), []);
  assert.deepEqual(problems({ after: "import { git } from '../packages/git/index.js';\n" }), []);
  assert.equal(problems({ before: old, after: "import { git, other } from './git.js';\n" }).length, 1,
    'a new binding does not borrow the old declaration allowance');
  assert.equal(problems({ before: "import './git.js';\n", after: "import './git.js';\nimport './git.js';\n" }).length, 1);
});

test('actual module syntax is checked without counting quoted examples or comments [C7,CD64]', () => {
  assert.deepEqual(problems({ after: `const text = "import { git } from './git.js';";\n// import './git.js';\n` }), []);
  assert.equal(problems({ after: "import {\n git\n} from './git.js';\n" }).length, 1);
  assert.equal(problems({ after: "export { git } from './git.js';\n" }).length, 1);
  assert.equal(problems({ after: "await import('./git.js');\n" }).length, 1);
  assert.equal(problems({ after: "import { git } from './g\\u0069t.js';\n" }).length, 1,
    'the canonical compiler decodes escaped module literals');
  const manifest = new Map([['package.json', JSON.stringify({ imports: { '#old': './src/git.js' } })]]);
  assert.equal(problems({ after: "import { git } from '#old';\n", extra: manifest }).length, 1);
});

test('only the exact finite temporary edge named by the frozen bar passes [C7,CD64]', () => {
  const metadata = edge => new Map([['packages/codemap/data/plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [edge] })]]);
  const edge = { importer: 'src/use.js', target: 'src/git.js', contractItem: 123, expires: '2099-01-01' };
  const after = "import { git } from './git.js';\n";
  assert.equal(problems({ after, extra: metadata(edge) }).length, 1, 'candidate metadata alone grants no exception');
  assert.deepEqual(problems({ after, extra: metadata(edge), criterion: 'Temporary edge src/use.js -> src/git.js until contract #123 lands.' }), []);
  assert.equal(problems({ after, extra: metadata({ ...edge, expires: '2000-01-01' }), criterion: 'src/use.js -> src/git.js' }).length, 1);
  assert.equal(problems({ after, extra: metadata({ ...edge, target: 'src/other.js' }), criterion: 'src/use.js -> src/git.js' }).length, 1);
});

test('the staged reader ignores unstaged fixes and retains imports already accepted on main [C7,CD64]', () => {
  const old = "import { git } from './git.js';\n";
  const snapshots = new Map([
    ['HEAD', new Map([...FILES, ['packages/codemap/data/plan/cells.json', JSON.stringify(PLAN)]])],
    [':index', new Map([...FILES, ['packages/codemap/data/plan/cells.json', JSON.stringify(PLAN)], ['src/use.js', old]])],
    ['accepted', new Map([...FILES, ['packages/codemap/data/plan/cells.json', JSON.stringify(PLAN)], ['src/use.js', old]])],
  ]);
  const read = (revision, name) => snapshots.get(revision)?.get(name);
  assert.equal(stagedShimImportProblems({ paths: ['src/use.js'], read, parseImports: importsIn }).length, 1);
  assert.deepEqual(stagedShimImportProblems({ paths: ['src/use.js'], read, accepted: 'accepted', parseImports: importsIn }), []);
});

test('the actual native pre-commit refuses staged shim imports and accepts the front door [C7,CD64]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  for (const [file, source] of FILES) {
    mkdirSync(join(box.repo, file, '..'), { recursive: true });
    writeFileSync(join(box.repo, file), source);
  }
  writeFileSync(join(box.repo, 'src/use.js'), "import { git } from './git.js';\n");
  box.git(box.repo, 'add', 'src', 'packages');
  box.git(box.repo, 'commit', '-q', '-m', 'test: preserve pre-migration dependency [G1]');
  mkdirSync(join(box.repo, 'packages/codemap/data/plan'), { recursive: true });
  const shard = 'packages/codemap/data/plan/00-git.json';
  writeFileSync(join(box.repo, 'packages/codemap/data/plan/cells.json'), JSON.stringify({ cells: [
    { order: 1, name: 'git', file: shard }] }));
  writeFileSync(join(box.repo, shard), JSON.stringify(PLAN.cells[0]));
  box.git(box.repo, 'add', 'packages/codemap/data/plan/cells.json', shard);
  box.git(box.repo, 'commit', '-q', '-m', 'test: declare existing cell migration [G1]');
  writeFileSync(join(box.repo, 'src/new.js'), "import { git } from './git.js';\n");
  box.git(box.repo, 'add', 'src/new.js');
  // A worktree-only correction must never hide the bad staged dependency.
  writeFileSync(join(box.repo, 'src/new.js'), "import { git } from '../packages/git/index.js';\n");
  const refused = (await box.runLocal(box.repo, 'hook', 'pre-commit'));
  assert.notEqual(refused.code, 0, refused.out + refused.err);
  assert.match(refused.out + refused.err, /src\/new.js:1:.*src\/git.js.*packages\/git\/index.js/u);
  box.git(box.repo, 'add', 'src/new.js');
  const accepted = (await box.runLocal(box.repo, 'hook', 'pre-commit'));
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  mkdirSync(join(box.repo, 'packages/codemap/data/plan'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/codemap/data/plan/temporary-edges.json'), JSON.stringify({ version: 1,
    edges: [{ importer: 'web/new.js', target: 'src/git.js', contractItem: 123, expires: '2099-01-01' }] }));
  box.git(box.repo, 'add', 'src/new.js', 'packages/codemap/data/plan/temporary-edges.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test: retain a bounded temporary edge [G1]');
  // The bars name src/git.js, so the web lane owns src/ and claim's cross-ownership guard stays out of the way.
  const { lanes } = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixturePolicy(box, { lanes: { ...lanes, web: { ...lanes.web, owns: [...lanes.web.owns, 'src/'] } } });
  box.git(box.web, 'merge', '-q', 'main');
  const folders = [];
  for (const [title, criterion] of [['Allowed edge', 'Temporary edge web/new.js -> src/git.js until contract #123 lands.'],
    ['No edge exception', 'Use the canonical front door.']]) {
    const added = (await fixtureAdd(box.runLocal, box.repo, 'web', title, '--specs', 'G1', '--criterion', criterion, '--check', 'true', '--wait', '--json'));
    assert.equal(added.code, 0, added.out + added.err);
    const id = JSON.parse(added.out).item.item_id;
    const claimed = (await box.runLocal(box.web, 'claim', String(id), '--json'));
    assert.equal(claimed.code, 0, claimed.out + claimed.err);
    folders.push(JSON.parse(claimed.out).itemFolder);
  }
  for (const folder of folders) {
    mkdirSync(join(folder, 'web'), { recursive: true });
    writeFileSync(join(folder, 'web/new.js'), "import { git } from '../src/git.js';\n");
    box.git(folder, 'add', 'web/new.js');
  }
  const ownBar = (await box.runLocal(folders[0], 'hook', 'pre-commit'));
  assert.equal(ownBar.code, 0, ownBar.out + ownBar.err);
  const siblingBar = (await box.runLocal(folders[1], 'hook', 'pre-commit'));
  assert.notEqual(siblingBar.code, 0, 'a sibling claim never lends its exception to this folder');
  assert.match(siblingBar.out + siblingBar.err, /web\/new\.js:1:.*src\/git\.js.*packages\/git\/index\.js/u);
});
