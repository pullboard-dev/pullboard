/** The trusted cells checker accepts served URLs, never a real deletion [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { acceptedCutItems } from '../../../../packages/landing/tests/fixtures/plan.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { requireSubmitCells as preflight } from '../../index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

/** The accepted inventory each fixture main's background producer published (#3533), by main commit. */
const published = new Map();

const requireSubmitCells = (root, main, ...args) => preflight(root, main, ...args, { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
  acceptedArtifact: published.get(main),
  readCutItems: (main, root) => acceptedCutItems(root, main), cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });

/** Commit the actual small plan and canonical baseline, with no production-source substitution. */
async function plannedFixture(t, prepare = () => {}) {
  // The accepted inventory is produced off-path by a background producer, so this fixture publishes it in a private machine home.
  const previous = process.env.PULLBOARD_MACHINE_HOME, machine = privateFixtureFiles('cells-stays-machine-').root;
  process.env.PULLBOARD_MACHINE_HOME = machine;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(machine, { recursive: true, force: true });
  });
  const box = fixture(t);
  prepare(box);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'plan actual fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'snapshot actual fixture debt');
  const main = git(box.root, 'rev-parse', 'HEAD').trim();
  const trunk = git(box.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const artifact = await warmAcceptedCells(box.root, main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk });
  assert.equal(artifact.available, true, 'the producer published the accepted inventory of main');
  published.set(main, artifact);
  return { ...box, main };
}

/** Commit the exact candidate the real immutable-snapshot preflight inspects. */
function commitCandidate(box) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'candidate composition');
  return git(box.root, 'rev-parse', 'HEAD').trim();
}

/** The refusal text a candidate draws, or an empty string when submit accepts it. */
async function refusal(promise) {
  try { await promise; return ''; } catch (error) { return error.message; }
}

/** A frozen item whose coordinator-written criterion carries `text`. */
const item = text => ({ item_frozen: JSON.stringify({ criterion: text }) });

test('a root-relative served URL is not a deleted path, while a relative one still refuses [C7,D3]', async t => {
  const box = await plannedFixture(t, fixture => {
    fixture.put('src/doomed.js', "import { stats } from './stats.js';\nexport const doomed = stats;\n");
    fixture.put('test/served.test.js', "const page = `await import('/src/doomed.js');`;\nconst url = 'http://127.0.0.1' + '/src/doomed.js';\nexport { page, url };\n");
  });
  git(box.root, 'rm', '-q', '--', 'src/doomed.js');
  writePlan(box.root, computePlan(box.root));
  assert.doesNotMatch(await refusal(requireSubmitCells(box.root, box.main, commitCandidate(box), item('Remove doomed.'))), /names deleted/u);
  box.put('test/served.test.js', "const page = `await import('./src/doomed.js');`;\nexport { page };\n");
  assert.match(await refusal(requireSubmitCells(box.root, box.main, commitCandidate(box), item('Remove doomed.'))),
    /test\/served\.test\.js:1 names deleted src\/doomed\.js inside a string/u);
});
