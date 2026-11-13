/** @pullboard-test-input apps/runner/src/io/scripts/worker.js docs/architecture.md packages/codemap/data/plan/cells.json packages/codemap/data/plan/seed.json packages/codemap/src/io/cells/scripts/plan.js packages/stats/index.js */
/** One command removes a cell's shims: repoint, delete, keep what would cut upward, and change nothing the second time [C7,D3]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { removeShims } from '../../../../packages/codemap/src/io/cells/shims.js';
import { scriptMentions } from '../../../../packages/codemap/src/io/cells/shims.js';
import { writeShimHandoff } from '../../../../packages/codemap/src/io/cells/shims.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { CONFIG } from '../../tests/fixtures/cells/shims.js';
import { readFixture } from '../../tests/fixtures/cells/shims.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { inventoryBuildCount } from '../../../../packages/codemap/index.js';
import { checkCuts } from '../../../../packages/codemap/src/io/cells/plan/engine.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const PARSERS = { importsIn, commonJsIn };
const TOOL = fileURLToPath(new URL('../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));
const SEED = { source: 'fixture', sha256: 'none', order: ['kernel', 'stats', 'mid', 'late', 'app:cli'],
  cells: { kernel: ['src/refused.js'], stats: ['src/stats.js'], mid: ['src/mid.js'], late: ['src/late.js'], 'app:cli': ['src/cli.js'] }, tests: {} };

/** A stats cell already moved behind shims, with one importer of every kind and one that would cut upward. */
function shimmed(t) {
  const box = fixture(t);
  const config = JSON.parse(CONFIG);
  config.lanes.core.owns.push('src/', 'bin/', 'test/');
  config.lanes.view.owns.push('src/view/');
  box.put('pullboard.json', JSON.stringify(config));
  box.put('packages/codemap/data/plan/seed.json', JSON.stringify(SEED));
  for (const file of ['src/board.js', 'src/claims.js', 'src/stats-flow.js']) box.put(file, 'export const unused = 1;\n');
  box.put('src/stats.js', 'export const stats = 1;\n');
  box.put('src/mid.js', "import { leaf } from './stats-leaf.js';\nexport const mid = leaf;\n");
  box.put('src/late.js', 'export const late = 1;\n');
  box.put('src/cli.js', "import { shell } from './stats.js';\nconsole.log(shell);\n");
  box.put('bin/tool.js', "import '../src/cli.js';\n");
  box.put('packages/stats/src/core/pure.js', 'export const pure = 1;\n');
  box.put('packages/stats/src/shell/shell.js', 'export const shell = 2;\nexport const extra = 3;\n');
  box.put('packages/stats/src/shell/leaf.js', 'export const leaf = 4;\n');
  box.put('packages/stats/core.js', 'export * from "./src/core/pure.js";\n');
  box.put('packages/stats/index.js', 'export * from "./core.js";\nexport { shell } from "./src/shell/shell.js";\nexport * from "../../src/late.js";\n');
  box.put('src/stats.js', 'export { pure, shell } from "../packages/stats/index.js";\nexport { extra } from "../packages/stats/src/shell/shell.js";\n');
  box.put('src/stats-leaf.js', 'export { leaf } from "../packages/stats/src/shell/leaf.js";\n');
  box.put('src/uses-shell.js', "import { shell } from './stats.js';\nexport { shell };\n");
  box.put('src/uses-extra.js', "import { extra } from './stats.js';\nexport { extra };\n");
  box.put('src/reader.js', "import { readFileSync } from 'node:fs';\nexport const text = readFileSync(new URL('./stats.js', import.meta.url), 'utf8');\nimport { resolve } from 'node:path';\nexport const here = resolve(import.meta.dirname, './stats.js');\n");
  box.put('test/pure.test.js', "import { pure } from '../src/stats.js';\nconsole.log(pure);\n");
  box.put('test/declared.test.js', '/** @pullboard-test-input src/stats.js package.json */\nexport const declared = 1;\n');
  const plan = computePlan(box.root);
  const order = ['kernel', 'stats', 'mid', 'late', 'app:cli', 'store', 'items'];
  for (const cell of plan.cells) cell.order = order.indexOf(cell.name) + 1;
  plan.cells.sort((a, b) => a.order - b.order);
  const stats = plan.cells.find(cell => cell.name === 'stats');
  Object.assign(stats, { root: 'packages/stats', frontDoor: 'packages/stats/index.js', pureFrontDoor: 'packages/stats/core.js',
    paths: [['src/stats.js', 'packages/stats/src/shell/shell.js', 'seed'], ['src/stats-leaf.js', 'packages/stats/src/shell/leaf.js', 'seed']],
    reexports: ['src/stats.js', 'src/stats-leaf.js'] });
  writePlan(box.root, plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'shimmed fixture');
  // The cell inventory reads indexed files only (6193b1e81b), so a file a case adds after this commit is staged as it is put.
  const put = (file, source) => { box.put(file, source); git(box.root, 'add', '--', file); };
  return { ...box, put, plan };
}


test('dbg [C7,D3]', t => {
  const box = shimmed(t);
  const out = [];
  out.push(box.plan.cells.map(c => c.name + ':' + c.order + ':' + c.root));
  out.push(JSON.stringify(box.plan.cells.map(c=>[c.name,c.order,c.paths?.length])));
  assert.fail('DBG ' + JSON.stringify(out));
});
