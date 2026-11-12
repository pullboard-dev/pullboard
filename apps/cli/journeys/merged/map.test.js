/** @pullboard-test-loads packages/store/src/io/board.js packages/codemap/src/io/map.js apps/cli/src/io/commands/map.js apps/cli/src/io/commands/merged.js apps/cli/src/io/commands/index.js apps/cli/src/io/commands/next.js apps/cli/src/io/commands/claim.js packages/codemap/src/io/slice.js apps/cli/src/io/main.js apps/cli/src/io/help.js apps/cli/src/logic/help.js src/land.js packages/config/src/io/templates.js apps/cli/tests/fixtures/board/submit.js */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  buildCodeMap,
  renderItemSlice,
} from '../../../../packages/codemap/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
const sliceMap = {
  mainCommit: 'a'.repeat(40),
  modules: [{
    path: 'src/leaf.js',
    loc: 3,
    job: 'A fixture leaf module.',
    dependencies: [],
    external: [],
    importedBy: [],
    tests: ['test/leaf.test.js'],
    functions: [{
      id: 'src/leaf.js#leaf', name: 'leaf', signature: 'leaf()', line: 1,
      summary: 'A fixture leaf function.', returns: null, transitiveEffects: [], throws: [],
      callers: [], calls: [], exported: true,
    }],
  }],
};
after(e2e.cleanup);

test('a function-only item slice includes its module and importer tests [C7]', () => {
  const slice = renderItemSlice(sliceMap, {
    item_id: 812, item_title: 'leaf', item_criterion: 'leaf is the named function', item_brief: '', item_files: '',
  });
  assert.match(slice, /## src\/leaf\.js/u, 'a named leaf includes its defining module');
  assert.match(slice, /test\/leaf\.test\.js/u, 'a named leaf includes tests importing its module');
});

test('an item slice keeps the whole output within its approximate budget [C7]', () => {
  const slice = renderItemSlice(sliceMap, {
    item_id: 813,
    item_title: 'Long title '.repeat(300),
    item_criterion: 'src/leaf.js is the named file',
    item_brief: '',
    item_files: 'src/leaf.js, '.repeat(300),
  }, { budget: 64 });
  assert.ok(slice.length <= 64 * 4, 'headers, cards and the omission notice share the output budget');
  assert.match(slice, /main: [a-f0-9]{40,64}/u, 'a bounded slice keeps its source stamp');
  assert.match(slice, /not evidence of no relationship/u, 'omitted context is not negative evidence');
});

test('an item slice refuses a budget too small for its required header [C7]', () => {
  assert.throws(() => renderItemSlice(sliceMap, { item_id: 814 }, { budget: 1 }), /budget too small/u);
});

test('a main-stamped map refuses dirty, untracked and deleted test import edges [C7]', () => {
  const box = e2e.project();
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'src/pinned.js'), 'export function pinned() { return true; }\n');
  const tracked = join(box.repo, 'test/pinned.test.js');
  const original = "import { pinned } from '../src/pinned.js';\nvoid pinned;\n";
  writeFileSync(tracked, original);
  box.git(box.repo, 'add', 'src/pinned.js', 'test/pinned.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: commit the source and importer together');
  const main = box.git(box.repo, 'rev-parse', 'main');
  const clean = buildCodeMap(box.repo, main);
  assert.deepEqual(clean.modules.find(module => module.path === 'src/pinned.js').tests, ['test/pinned.test.js']);
  writeFileSync(tracked, 'export const changed = true;\n');
  assert.throws(() => buildCodeMap(box.repo, main), /test\/.*differs|test.*differs/u,
    'dirty tracked imports cannot acquire the committed main stamp');
  writeFileSync(tracked, original);
  const untracked = join(box.repo, 'test/untracked.test.js');
  writeFileSync(untracked, original);
  assert.throws(() => buildCodeMap(box.repo, main), /test\/.*differs|test.*differs/u,
    'untracked importer paths cannot acquire the committed main stamp');
  rmSync(untracked);
  rmSync(tracked);
  assert.throws(() => buildCodeMap(box.repo, main), /test\/.*differs|test.*differs/u,
    'deleted importer paths cannot acquire the committed main stamp');
  writeFileSync(tracked, original);
  assert.deepEqual(buildCodeMap(box.repo, main).modules.find(module => module.path === 'src/pinned.js').tests,
    ['test/pinned.test.js'], 'restoring the exact committed test bytes restores the map');
});

test('a fresh main-stamped map refuses ignored source, executable and test inputs [C7]', () => {
  const box = e2e.project();
  for (const directory of ['src', 'bin', 'test']) mkdirSync(join(box.repo, directory), { recursive: true });
  writeFileSync(join(box.repo, 'src/pinned.js'), 'export function pinned() { return true; }\n');
  const ignored = ['src/ignored.js', 'bin/ignored.mjs', 'test/ignored.test.js'];
  writeFileSync(join(box.repo, '.gitignore'), `${ignored.join('\n')}\n`);
  box.git(box.repo, 'add', 'src/pinned.js', '.gitignore');
  box.git(box.repo, 'commit', '-q', '-m', 'test: record ignored map input patterns');
  const main = box.git(box.repo, 'rev-parse', 'main');
  assert.deepEqual(buildCodeMap(box.repo, main).modules.map(module => module.path), ['src/pinned.js']);
  for (const path of ignored) {
    writeFileSync(join(box.repo, path), "import { pinned } from '../src/pinned.js';\nvoid pinned;\n");
    assert.equal(box.git(box.repo, 'status', '--porcelain', '--untracked-files=all', '--', path), '',
      'the committed ignore rule really hides this input from ordinary status');
    assert.throws(() => buildCodeMap(box.repo, main), /differs from the committed main source/u,
      `${path} cannot acquire the committed main stamp on a fresh scan`);
    rmSync(join(box.repo, path));
  }
  assert.deepEqual(buildCodeMap(box.repo, main).modules.map(module => module.path), ['src/pinned.js'],
    'a clean tree with unused ignore rules remains valid');
});

test('a main-stamped map validates actual inputs despite index flags and symbolic links [C7]', () => {
  const box = e2e.project();
  const paths = ['src/pinned.js', 'bin/pinned.mjs', 'test/pinned.test.js'];
  const original = 'export function pinned() { return true; }\n';
  for (const directory of ['src', 'bin', 'test']) mkdirSync(join(box.repo, directory), { recursive: true });
  for (const path of paths) writeFileSync(join(box.repo, path), original);
  box.git(box.repo, 'add', ...paths);
  box.git(box.repo, 'commit', '-q', '-m', 'test: commit all scanned input kinds');
  const main = box.git(box.repo, 'rev-parse', 'main');
  assert.ok(buildCodeMap(box.repo, main).modules.length);
  for (const flag of ['assume-unchanged', 'skip-worktree']) for (const path of paths) {
    box.git(box.repo, 'update-index', `--${flag}`, path);
    writeFileSync(join(box.repo, path), 'export function altered() { return false; }\n');
    assert.equal(box.git(box.repo, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', path), '',
      `${flag} really hides changed ${path} from status`);
    assert.throws(() => buildCodeMap(box.repo, main), /committed main source/u,
      `actual ${path} bytes must match main despite ${flag}`);
    writeFileSync(join(box.repo, path), original);
    box.git(box.repo, 'update-index', `--no-${flag}`, path);
  }
  const target = join(box.dir, 'outside-source.js');
  writeFileSync(target, 'export function outside() { return 1; }\n');
  for (const path of paths) {
    rmSync(join(box.repo, path));
    symlinkSync(target, join(box.repo, path));
    box.git(box.repo, 'add', path);
    box.git(box.repo, 'commit', '-q', '-m', 'test: commit a symbolic input path');
    assert.throws(() => buildCodeMap(box.repo, box.git(box.repo, 'rev-parse', 'main')), /committed main source/u,
      'a committed link never authorizes reading its external target bytes as main');
    rmSync(join(box.repo, path));
    writeFileSync(join(box.repo, path), original);
    box.git(box.repo, 'add', path);
    box.git(box.repo, 'commit', '-q', '-m', 'test: restore the regular input');
  }
  assert.ok(buildCodeMap(box.repo, box.git(box.repo, 'rev-parse', 'main')).modules.length,
    'exact regular committed inputs still scan after all negative controls');
});

test('pullboard map prints the overview, a card and an item slice from one scan [C7]', async t => {
  const box = e2e.project();
  t.after(() => e2e.cleanup());
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.web.owns.push('src/', 'bin/', 'test/');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  mkdirSync(join(box.repo, 'bin'), { recursive: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  const templateDecoy = 'const templateDecoy = ' + String.fromCharCode(96)
    + 'import { ghost } from "./ghost.js"; async function fakeTemplate() {}' + String.fromCharCode(96) + ';';
  writeFileSync(join(box.repo, 'src/home.js'), [
    '/** Render the fixture home page.',
    ' * @returns {string} page markup',
    ' */',
    'export async function renderHome() { return \"home\"; }',
    '/* async function fakeExport() { return 0; } */',
    'const decoy = ' + JSON.stringify("import { hidden } from './hidden.js'; async function fakeString() {}") + ';',
    templateDecoy,
    'const unsupportedObjectMethod = { nestedMethod() { return true; } };',
  ].join('\n') + '\n');
  writeFileSync(join(box.repo, 'src/public.js'), "export { renderHome as displayHome } from './home.js';\n");
  writeFileSync(join(box.repo, 'bin/start.js'), "import { displayHome as render } from '../src/public.js';\nexport async function start() { return render(); }\n");
  writeFileSync(join(box.repo, 'test/home.test.js'), "import { renderHome } from '../src/home.js';\nvoid renderHome;\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test(core): add code map source fixture');
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Map fixture item', '--criterion',
    'src/home.js exports renderHome and test/home.test.js imports it', '--specs', 'G1', '--check', 'true', '--route', 'mid',
    '--brief', 'Files: src/home.js, src/public.js, bin/start.js, test/home.test.js\nTest: map output follows imports and ignores misleading source text', '--json'));
  assert.equal(added.code, 0, added.out + added.err);
  const itemId = JSON.parse(added.out).item.item_id;
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  store.board_ensureCoordinator(board, box.repo);
  const agent = store.agentAt(board, box.web);
  assert.ok(agent, 'the fixture builder remains joined to its web lane');
  const agentId = agent.agent_id;
  const claimHead = box.git(box.repo, 'rev-parse', 'HEAD');
  const frozen = JSON.stringify({ criterion: 'src/home.js exports renderHome and test/home.test.js imports it' });
  const digest = createHash('sha256').update(frozen).digest('hex');
  store.claim(board, itemId, { agentId, lane: 'web', leaseMs: 3_600_000,
    freeze: () => ({ text: frozen, digest }), head: claimHead });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/map-item.txt'), 'accepted map fixture item\n');
  box.git(box.repo, 'add', 'web/map-item.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): add mapped fixture item [G1]');
  const itemCommit = box.git(box.repo, 'rev-parse', 'HEAD');
  submitFixture(board, itemId, { agentId, commit: itemCommit, tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') });
  store.verify(board, itemId, { agentId: 'coordinator', decision: 'ACCEPT', note: 'confirmed map fixture source',
    head: itemCommit, digest, policy: 'any' });
  t.after(() => store.closeBoard(board));

  const cache = join(box.repo, '.git', 'pullboard', 'code-map.json');
  const overview = (await box.runLocal(box.repo, 'map'));
  assert.equal(overview.code, 0, overview.out + overview.err);
  const firstGeneration = JSON.parse(readFileSync(cache, 'utf8')).generatedAt;
  assert.match(overview.out, /Pullboard code map \([a-f0-9]{12}\)/u);
  assert.match(overview.out, /Effects not covered by patterns: not detected/u);
  const commandHelp = (await box.runLocal(box.repo, 'help', 'map'));
  assert.equal(commandHelp.code, 0, commandHelp.out + commandHelp.err);
  assert.match(commandHelp.out, /--for <item>/u);
  const card = (await box.runLocal(box.repo, 'map', 'src/home.js'));
  assert.equal(card.code, 0, card.out + card.err);
  assert.match(card.out, /renderHome\(\)/u);
  assert.match(card.out, /Render the fixture home page/u);
  assert.match(card.out, /tests with observed imports: test\/home\.test\.js/u);
  assert.match(card.out, /Effects the scan cannot see: not detected/u);
  assert.doesNotMatch(card.out, /fakeExport|fakeString|fakeTemplate|hidden\.js|ghost\.js/u);
  const functionCard = (await box.runLocal(box.repo, 'map', 'renderHome'));
  assert.equal(functionCard.code, 0, functionCard.out + functionCard.err);
  assert.match(functionCard.out, /## src\/home\.js#renderHome/u);
  const alias = (await box.runLocal(box.repo, 'map', 'bin/start.js'));
  assert.equal(alias.code, 0, alias.out + alias.err);
  assert.match(alias.out, /home\.js#renderHome/u, 'an import alias follows its local re-export');
  const slice = (await box.runLocal(box.repo, 'map', '--for', String(itemId)));
  assert.equal(slice.code, 0, slice.out + slice.err);
  assert.match(slice.out, /src\/home\.js/u);
  assert.match(slice.out, /renderHome/u);
  assert.match(slice.out, /test\/home\.test\.js/u);
  const tooSmall = (await box.runLocal(box.repo, 'map', '--for', String(itemId), '--budget', '1'));
  assert.notEqual(tooSmall.code, 0);
  assert.match(tooSmall.out + tooSmall.err, /item slice budget too small/u);
  const firstMap = JSON.parse(readFileSync(cache, 'utf8'));
  assert.equal(firstMap.generatedAt, firstGeneration, 'overview, cards and slices reuse one exact source scan');
  assert.equal(firstMap.mainCommit, box.git(box.repo, 'rev-parse', 'main'));
  assert.equal(firstMap.sourceCommit, firstMap.mainCommit);
  assert.deepEqual(firstMap.modules.find(module => module.path === 'src/home.js').functions.map(fn => fn.name), ['renderHome']);

  writeFileSync(join(box.repo, 'src/landed.js'), 'export function landed() { return true; }\n');
  box.git(box.repo, 'add', 'src/landed.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test(core): land another code map module');
  const landed = (await box.runLocal(box.repo, 'merged', String(itemId), 'HEAD'));
  assert.equal(landed.code, 0, landed.out + landed.err);
  const refreshed = JSON.parse(readFileSync(cache, 'utf8'));
  assert.equal(refreshed.mainCommit, box.git(box.repo, 'rev-parse', 'main'));
  assert.ok(refreshed.modules.some(module => module.path === 'src/landed.js'));
  assert.notEqual(refreshed.generatedAt, firstMap.generatedAt);
});


/** A scanned constructor is classified without ever evaluating the fixture source. */
test('the map still detects a socket constructor as a network effect [C7,P5]', () => {
  const box = e2e.project();
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/socket.js'), 'export function connectSocket(address) { return new WebSocket(address); }\n');
  box.git(box.repo, 'add', 'src/socket.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: record unevaluated socket source');
  const map = buildCodeMap(box.repo, box.git(box.repo, 'rev-parse', 'main'));
  const connect = map.modules.find(module => module.path === 'src/socket.js').functions.find(fn => fn.name === 'connectSocket');
  assert.ok(connect.effects.includes('network'));
});

test('next prints the item slice when the map setting is on [C7]', async t => {
  const box = e2e.project();
  t.after(() => e2e.cleanup());
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.web.owns.push('src/', 'test/');
  config.map = { slice: true };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'src/home.js'), 'export async function renderHome() { return "home"; }\n');
  writeFileSync(join(box.repo, 'test/home.test.js'), "import { renderHome } from '../src/home.js';\nvoid renderHome;\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test(core): add slice fixture source');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Slice fixture item', '--criterion',
    'src/home.js exports renderHome and test/home.test.js imports it', '--specs', 'G1', '--check', 'true', '--route', 'mid',
    '--brief', 'Files: src/home.js\nTest: test/home.test.js imports it\nOut of scope: anything else'));
  assert.equal(added.code, 0, added.out + added.err);
  const claimed = (await box.runLocal(box.web, 'next'));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  assert.match(claimed.out, /# Slice for #\d+/u, 'next prints the slice header for the claimed item');
  assert.match(claimed.out, /renderHome/u, 'the slice names the function the item names');
  assert.match(claimed.out, /test\/home\.test\.js/u, 'the slice lists the test importing the named module');
});
