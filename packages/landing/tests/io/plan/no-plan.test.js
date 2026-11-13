/** @pullboard-test-input source-tree */
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

test('clause 1: with no cells plan in the tree, a new file lands through derive, the recorded check and the scan with no plan refusal [C7]', async t => {
  const { root, base, tip } = candidate(t);
  assert.equal(existsSync(join(root, 'packages/codemap/data/plan/cells.json')), false);
  assert.deepEqual(amendLandingEngines(root).assigned, []);
  assert.equal(git(root, 'rev-parse', 'HEAD'), tip, 'a new source file needs no amend');
  assert.doesNotThrow(() => requireLandingPlanCheck(root, tip));
  assert.deepEqual(await scanLanding(root, base, tip), []);
});

test('clause 2: the landing source under io names no cells plan and no placement call [C7]', () => {
  const text = walk(IO).filter(file => file.endsWith('.js')).map(file => [file, readFileSync(file, 'utf8')]);
  const hits = text.filter(([, source]) => /cells-plan|cells\.json|plan\.js|placeLanding|landingPlacementProblems|addedPlacementProblems/u.test(source)).map(([file]) => file);
  assert.deepEqual(hits, []);
});
