/** @pullboard-test-input source-cell packages/codemap */
/** The slice that next and claim print with map.slice on is the ranked item slice, read from a real main checkout [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sayMapSlice } from '../../src/io/slice.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
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
