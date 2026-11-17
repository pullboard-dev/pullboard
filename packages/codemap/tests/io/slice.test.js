/** @pullboard-test-input source-cell packages/codemap */
/** The slice that next and claim print with map.slice on is the ranked item slice, read from a real main checkout [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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

test('clause 3: with map.slice on, sayMapSlice prints the ranked slice naming the item packages/ module within 1,500 tokens, and nothing with map.slice unset [C7]', async () => {
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
    assert.deepEqual(quiet, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
