/** @pullboard-test-input source-cell packages/codemap */
/** The slice that next and claim print with map.slice on is the ranked item slice, read from a real main checkout [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sayMapSlice } from '../../src/io/slice.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../gate/tests/fixtures/testkit.js';

/** A committed main checkout: one target module with a helper and a test, plus many modules sharing a generic name. */
function fixture() {
  const { root, write } = privateFixtureFiles('pullboard-codemap-slice-');
  const files = {
    'packages/demo/src/io/target.js': "import { helpOut } from './helper.js';\n/** Serve the target page. */\nexport function serveTarget() { return helpOut(); }\n",
    'packages/demo/src/io/helper.js': '/** Help out. */\nexport function helpOut() { return 1; }\n',
    'packages/demo/tests/io/target.test.js': "import { serveTarget } from '../../src/io/target.js';\nserveTarget();\n",
  };
  for (let index = 0; index < 40; index += 1) {
    files[`packages/noise/src/io/view-${index}.js`] = `/** View ${index}. */\nexport function render() { return ${index}; }\n`
      + `/** A long helper so each card costs real space. */\nexport function noiseHelper${index}(first, second, third) { return first + second + third; }\n`;
  }
  for (const [path, text] of Object.entries(files)) write(path, text);
  fixtureCommitAll(root);
  return root;
}

test('codemap.io-slice.on-prints-ranked-slice: clause 2: with map.slice on, sayMapSlice prints the ranked slice naming the item packages/ module within 1,500 tokens, and with map.slice unset the one line [C7,#11784]', async () => {
  const root = fixture();
  try {
    const item = { item_id: 41, item_title: 'Render the target page', item_criterion: '1. packages/demo/src/io/target.js serves the page [test]', item_brief: '', item_files: '', item_check: '' };
    const info = { commonDir: join(root, '.git') };
    const said = [];
    const io = { say: text => said.push(text) };
    await sayMapSlice(io, { config: { map: { slice: true } }, info }, item, () => root);
    assert.equal(said.length, 1);
    const [slice] = said;
    assert.match(slice, /^# Slice for #41$/mu);
    assert.match(slice, /^## packages\/demo\/src\/io\/target\.js /mu);
    assert.match(slice, /^closest modules: packages\/demo\/src\/io\/target\.js, packages\/demo\/src\/io\/helper\.js$/mu);
    assert.match(slice, /^tests with observed imports of the closest modules: packages\/demo\/tests\/io\/target\.test\.js$/mu);
    assert.doesNotMatch(slice, /packages\/noise\//u, 'a name defined in many modules pulls none of them in');
    assert.ok(slice.length <= 1500 * 4, `slice is ${slice.length} characters`);

    const quiet = [];
    await sayMapSlice({ say: text => quiet.push(text) }, { config: {}, info }, item, () => root);
    assert.deepEqual(quiet, ['code map: pullboard map --for 41']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codemap.io-slice.off-names-command: clause 1: with map.slice unset or false, sayMapSlice prints exactly one line naming pullboard map --for <item id> and builds no map [C7,#11784]', async () => {
  const info = { commonDir: join(tmpdir(), 'pullboard-codemap-slice-absent') };
  for (const config of [{}, { map: {} }, { map: { slice: false } }]) {
    const said = [];
    await sayMapSlice({ say: text => said.push(text) }, { config, info }, { item_id: 77 }, () => { throw new Error('off must not resolve a checkout or build a map'); });
    assert.deepEqual(said, ['code map: pullboard map --for 77']);
  }
  assert.equal(existsSync(join(info.commonDir, 'pullboard', 'code-map.json')), false, 'no map file was built');
});

test('codemap.io-slice.no-item-silent: clause 3: a call with no item prints nothing, with map.slice on or off, so next stays quiet when it hands nothing out [C7,#11784]', async () => {
  for (const config of [{}, { map: { slice: true } }]) {
    const said = [];
    await sayMapSlice({ say: text => said.push(text) }, { config, info: {} }, undefined, () => { throw new Error('no item resolves no checkout'); });
    assert.deepEqual(said, []);
  }
});

/** Run sayMapSlice for one item against a fixture root and return what it said and how long it took. */
async function sliceOnce(root, item) {
  const said = [];
  const started = performance.now();
  await sayMapSlice({ say: text => said.push(text) }, { config: { map: { slice: true } }, info: { commonDir: join(root, '.git') } }, item, () => root);
  return { said, ms: performance.now() - started };
}

const TARGET_ITEM = { item_id: 52, item_title: 'Render the target page', item_criterion: '1. packages/demo/src/io/target.js serves the page [test]', item_brief: '', item_files: '', item_check: '' };

test('codemap.io-slice.cached-per-item-and-main: clause 1: a second sayMapSlice for the same item at the same main commit prints the same slice with the map unreadable [C7,#12591]', async () => {
  const root = fixture();
  try {
    const first = await sliceOnce(root, TARGET_ITEM);
    assert.equal(first.said.length, 1);
    assert.match(first.said[0], /^# Slice for #52$/mu);
    const mapFile = join(root, '.git', 'pullboard', 'code-map.json');
    rmSync(mapFile, { force: true });
    mkdirSync(mapFile);
    const second = await sliceOnce(root, TARGET_ITEM);
    assert.deepEqual(second.said, first.said, 'the cached text is printed without reading or rebuilding the map');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codemap.io-slice.cached-cost-flat-with-map-size: clause 2: with a cached slice, repeat calls stay under 50 ms and within 2x whether the map file is 100 KB or 10 MB [C7,#12591]', async () => {
  const root = fixture();
  try {
    await sliceOnce(root, TARGET_ITEM);
    const mapFile = join(root, '.git', 'pullboard', 'code-map.json');
    const median = async () => {
      const times = [];
      for (let index = 0; index < 10; index += 1) times.push((await sliceOnce(root, TARGET_ITEM)).ms);
      return times.sort((left, right) => left - right)[5];
    };
    writeFileSync(mapFile, ' '.repeat(100 * 1024));
    const small = await median();
    writeFileSync(mapFile, ' '.repeat(10 * 1024 * 1024));
    assert.ok(statSync(mapFile).size >= 10 * 1024 * 1024);
    const large = await median();
    assert.ok(large < 50, `median with a 10 MB map was ${large} ms`);
    assert.ok(large <= 2 * Math.max(small, 1), `median ${large} ms with 10 MB vs ${small} ms with 100 KB`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codemap.io-slice.new-main-renders-fresh: clause 3: after main moves to a commit changing a file the item names, the next sayMapSlice prints the new commit slice, not the cached text [C7,#12591]', async () => {
  const root = fixture();
  try {
    const first = await sliceOnce(root, TARGET_ITEM);
    writeFileSync(join(root, 'packages/demo/src/io/target.js'), "import { helpOut } from './helper.js';\n/** Serve the target page. */\nexport function serveTarget() { return helpOut(); }\n/** Serve a second page. */\nexport function serveSecondPage() { return 2; }\n");
    const git = (...args) => runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root });
    git('add', '.');
    git('commit', '-q', '-m', 'change target');
    const second = await sliceOnce(root, TARGET_ITEM);
    assert.notDeepEqual(second.said, first.said);
    assert.match(second.said[0], /serveSecondPage/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
