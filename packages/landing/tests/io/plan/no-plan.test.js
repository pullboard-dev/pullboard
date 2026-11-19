/** @pullboard-test-input source-cell packages/landing */
/** Landing derives, guards and scans a batch without reading the cells plan, which is absent from the tree [C7,#6295]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { amendLandingEngines } from '../../../index.js';
import { requireLandingPlanCheck } from '../../../index.js';
import { scanLanding } from '../../../src/io/scan.js';

/** Names a landing source must not carry; plan.js is matched only as a whole file name, so parallel-plan.js is not a cells plan module. */
const PLAN_NAMES = /cells-plan|cells\.json|(?:^|[/'"])plan\.js|placeLanding|landingPlacementProblems|addedPlacementProblems/u;

const IO = fileURLToPath(new URL('../../../src/io', import.meta.url));

/** Every file under a folder. */
function walk(folder) {
  return readdirSync(folder).flatMap(name => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The shared fixture repository, which carries no cells plan, plus a candidate commit that adds one source file. */
function candidate(t) {
  const { root, put } = fixture(t);
  const base = git(root, 'rev-parse', 'HEAD');
  put('src/added.js', "import { board } from './board.js';\nexport const added = board;\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'candidate');
  return { root, base, tip: git(root, 'rev-parse', 'HEAD') };
}

test('landing.no-plan.with-no-cells-plan-in-the: clause 1: with no cells plan in the tree, a new file lands through derive, the recorded check and the scan with no plan refusal [C7]', async t => {
  const { root, base, tip } = candidate(t);
  assert.equal(existsSync(join(root, 'packages/codemap/data/plan/cells.json')), false);
  assert.deepEqual(amendLandingEngines(root).assigned, []);
  assert.equal(git(root, 'rev-parse', 'HEAD'), tip, 'a new source file needs no amend');
  assert.doesNotThrow(() => requireLandingPlanCheck(root, tip));
  assert.deepEqual(await scanLanding(root, base, tip), []);
});

test('landing.no-plan.the-landing-source-under-io-names: clause 2: the landing source under io names no cells plan and no placement call [C7]', () => {
  const text = walk(IO).filter(file => file.endsWith('.js')).map(file => [file, readFileSync(file, 'utf8')]);
  const hits = text.filter(([, source]) => PLAN_NAMES.test(source)).map(([file]) => file);
  assert.deepEqual(hits, []);
});

test('landing.no-plan.the-scan-still-flags-a-plan-module: clause 2: the scan still flags a source importing a plan.js module and passes one importing parallel-plan.js [C7]', () => {
  assert.ok(PLAN_NAMES.test("import { plan } from '../../logic/cells/plan.js';"));
  assert.ok(PLAN_NAMES.test('import { plan } from "./plan.js";'));
  assert.equal(PLAN_NAMES.test("import { parallelGatePlan } from '../../logic/parallel-plan.js';"), false);
});
