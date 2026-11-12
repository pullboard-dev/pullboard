/** The refusal audit and sealed-cell selection pick the right units and journeys [C7,M1,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  privateFixtureFiles,
  runFixtureChild,
  runFixtureGit,
} from '../../../tests/fixtures/child.js';
import { writeTestTiers } from '../../../../../packages/gate/index.js';
import { selectTestTiers } from '../../../../../packages/gate/index.js';
import {
  commit,
  fixture,
  build,
} from '../../../tests/fixtures/test/selection.js';

/** A real repository whose machine audit reads source text for refusal codes, as apps/cli/journeys/verify/machine.test.js does, and imports nothing from the sources. */
function auditFixture(t) {
  const root = privateFixtureFiles('pullboard-refusal-floor-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => String(runFixtureGit(args, { cwd: root, encoding: 'utf8' })).trim();
  const commitAll = message => { git('add', '-A'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(root, `packages/${name}/src`), { recursive: true });
    writeFileSync(join(root, `packages/${name}/index.js`), `export * from './src/${name}.js';\n`);
    writeFileSync(join(root, `packages/${name}/src/${name}.js`), `export const ${name} = 1;\nexport function fail() { throw new Refused('KNOWN_${name.toUpperCase()}', 'x'); }\n`);
  }
  mkdirSync(join(root, 'test'), { recursive: true });
  for (const name of ['alpha', 'beta']) writeFileSync(join(root, `test/${name}.test.js`), `import { test } from 'node:test';\nimport '../packages/${name}/index.js';\ntest('${name} loads', () => {});\n`);
  mkdirSync(join(root, 'apps/cli/journeys/verify'), { recursive: true });
  writeFileSync(join(root, 'apps/cli/journeys/verify/machine.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import '../../../../packages/alpha/index.js';
import '../../../../packages/beta/index.js';
const declared = new Set(['KNOWN_ALPHA', 'KNOWN_BETA']);
test('every refusal a move raises today is declared on that move [M1]', () => {
  const raised = ['alpha', 'beta'].flatMap(name => [...readFileSync(new URL('../../../../packages/' + name + '/src/' + name + '.js', import.meta.url), 'utf8').matchAll(/new Refused\\('([A-Z_]+)'/g)].map(match => match[1]));
  assert.deepEqual(raised.filter(code => !declared.has(code)), []);
});
`);
  const manifest = writeTestTiers(root).manifest;
  assert.equal(manifest.files.find(row => row.file === 'apps/cli/journeys/verify/machine.test.js').tier, 'T3', 'the audit imports two packages, so it is a journey that waits for landing');
  const base = commitAll('test: base with the declaration audit [M1]');
  return { root, git, commitAll, base };
}

test('clause 1: a submit whose diff adds a refusal code runs apps/cli/journeys/verify/machine.test.js though no import path reaches it [M1,V4]', t => {
  const f = auditFixture(t);
  writeFileSync(join(f.root, 'packages/alpha/src/alpha.js'), `export const alpha = 1;\nexport function fail() { throw new Refused('KNOWN_ALPHA', 'x'); }\nexport function more() { throw new Refused('BRAND_NEW_CODE', 'y'); }\n`);
  const head = f.commitAll('feat(alpha): raise a new refusal [M1]');
  const plan = selectTestTiers(f.root, { base: f.base, commit: head });
  assert.ok(plan.units.includes('apps/cli/journeys/verify/machine.test.js'), `units: ${plan.units.join(', ')}`);
  assert.ok(!plan.journeys.includes('apps/cli/journeys/verify/machine.test.js'), 'the audit no longer waits for landing');
});

test('clause 2: a change that raises an undeclared refusal code is refused at submit with the machine.test.js case named [M1,V4]', t => {
  const f = auditFixture(t);
  writeFileSync(join(f.root, 'packages/beta/src/beta.js'), `export const beta = 1;\nexport function fail() { throw new Refused('KNOWN_BETA', 'x'); }\nexport function more() { throw new Refused('UNDECLARED_CODE', 'y'); }\n`);
  const head = f.commitAll('feat(beta): raise an undeclared refusal [M1]');
  const plan = selectTestTiers(f.root, { base: f.base, commit: head });
  assert.ok(plan.units.includes('apps/cli/journeys/verify/machine.test.js'));
  const run = runFixtureChild(process.execPath, ['--test', ...plan.units.filter(file => file === 'apps/cli/journeys/verify/machine.test.js')], { cwd: f.root, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')) });
  assert.notEqual(run.status, 0, `the selected audit fails the submit run`);
  assert.match(`${run.stdout}${run.stderr}`, /every refusal a move raises today is declared on that move/u, 'the failing case is named');
});

test('clause 3: a diff that touches no refusal code does not add machine.test.js to its submit check [M1,V4]', t => {
  const f = auditFixture(t);
  writeFileSync(join(f.root, 'packages/alpha/src/alpha.js'), `export const alpha = 2;\nexport function fail() { throw new Refused('KNOWN_ALPHA', 'changed message'); }\n`);
  const head = f.commitAll('feat(alpha): change a value and a message [M1]');
  const plan = selectTestTiers(f.root, { base: f.base, commit: head });
  assert.ok(!plan.units.includes('apps/cli/journeys/verify/machine.test.js'), `units: ${plan.units.join(', ')}`);
  assert.ok(plan.journeys.includes('apps/cli/journeys/verify/machine.test.js'), 'it stays a landing journey');
});

test('clause 3: a change confined to a sealed cell selects only that cell\'s own units, and the plan names the sealed cells [C7]', t => {
  const box = fixture(t);
  // The listing is the coordinator's file, so main records it and the builder's lane only changes its own cell.
  mkdirSync(join(box.repo, 'bin/checks'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/gate/data/tests/test-cells.json'), JSON.stringify({ version: 1, sealed: ['alpha', 'beta'] }) + '\n');
  const sealedBase = commit(box, box.repo, 'chore: record the sealed test cells [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const entry = build(box, 'alpha', 2);
  const plan = selectTestTiers(entry.root, { base: sealedBase, commit: entry.head });
  assert.deepEqual(plan.sealedCells, ['alpha', 'beta'], 'the plan reads the committed sealed-cell listing');
  assert.deepEqual(plan.units, ['test/alpha.test.js'], 'beta is sealed and unchanged, so none of its tests are selected');
  assert.deepEqual(plan.packages, ['.', 'packages/alpha'], 'only the changed cell and the root importer of its front door');
  assert.deepEqual(plan.journeys, [], 'a change confined to sealed cells runs no journey (#4003)');
});

/** Record a sealed-cell listing on main, as the coordinator does, and bring the builder's worktree up to it. */
function sealOnMain(box, sealed, extra = () => {}) {
  mkdirSync(join(box.repo, 'bin/checks'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/gate/data/tests/test-cells.json'), JSON.stringify({ version: 1, sealed }) + '\n');
  extra();
  const base = commit(box, box.repo, 'chore: record the sealed test cells [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return base;
}

test('#4003 clause 1: a change inside a sealed cell\'s internals selects that cell\'s own tests and no root journey [C7]', t => {
  const box = fixture(t);
  const base = sealOnMain(box, ['alpha', 'beta'], () => {
    mkdirSync(join(box.repo, 'packages/alpha/src'), { recursive: true });
    writeFileSync(join(box.repo, 'packages/alpha/src/inner.js'), 'export const inner = 1;\n');
    mkdirSync(join(box.repo, 'packages/alpha/tests'), { recursive: true });
    writeFileSync(join(box.repo, 'packages/alpha/tests/inner.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { inner } from '../src/inner.js';\ntest('inner is a number [G1]', () => assert.equal(typeof inner, 'number'));\n");
    writeTestTiers(box.repo);
  });
  writeFileSync(join(box.web, 'packages/alpha/src/inner.js'), 'export const inner = 2;\n');
  const head = commit(box, box.web, 'feat(web): change alpha internals [G1]');
  const plan = selectTestTiers(box.web, { base, commit: head });
  assert.deepEqual(plan.units, ['packages/alpha/tests/inner.test.js', 'test/alpha.test.js'], 'the sealed cell\'s own test and the unit that reaches only it');
  assert.deepEqual(plan.journeys, [], 'no root test/ journey');
});

test('#4003 clause 2: a change to a sealed cell\'s front door also selects the contract tests of the cells that import it [C7]', t => {
  const box = fixture(t);
  const base = sealOnMain(box, ['alpha', 'beta'], () => {
    mkdirSync(join(box.repo, 'packages/beta/contract'), { recursive: true });
    writeFileSync(join(box.repo, 'packages/beta/contract/alpha-door.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { n } from '../../alpha/index.js';\ntest('beta reads alpha through its front door [G1]', () => assert.equal(typeof n, 'number'));\n");
    mkdirSync(join(box.repo, 'packages/gamma/contract'), { recursive: true });
    writeFileSync(join(box.repo, 'packages/gamma/contract/own.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { n } from '../index.js';\ntest('gamma keeps its own door [G1]', () => assert.equal(typeof n, 'number'));\n");
    writeTestTiers(box.repo);
  });
  writeFileSync(join(box.web, 'packages/alpha/index.js'), 'export const n = 3;\n');
  const head = commit(box, box.web, 'feat(web): change alpha front door [G1]');
  const plan = selectTestTiers(box.web, { base, commit: head });
  assert.ok(plan.units.includes('packages/beta/contract/alpha-door.test.js'), `units: ${plan.units.join(', ')}`);
  assert.equal(plan.units.includes('packages/gamma/contract/own.test.js'), false, 'a contract test that does not reach the door stays out');
  assert.deepEqual(plan.journeys, []);
});
