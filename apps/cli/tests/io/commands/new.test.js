/** @pullboard-test-input apps/cli/src/io/commands/new.js apps/cli/src/logic/new-package.js apps/cli/src/logic/new-package.json apps/cli/tests/fixtures/e2e.js */
/** pullboard new package writes the files newPackageFiles returns under packages/<name>, and refuses an existing folder or a bad first word [C7,#11426]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { run } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { newPackageFiles } from '../../../src/logic/new-package.js';
import { cellLintParsers } from '../../../../../packages/codemap/index.js';
import { cellLintReport } from '../../../../../packages/codemap/index.js';
import { withCellLintParser } from '../../../../../packages/codemap/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('cli.io-commands-new.writes-anatomy-files: clause 1: new package <name> --purpose writes exactly the files newPackageFiles returns under packages/<name> and prints each path [C7,#11426]', async () => {
  const box = e2e.project();
  const expected = newPackageFiles('tidy-cell', 'keeps the shelves tidy');
  const made = await box.runLocal(box.repo, 'new', 'package', 'tidy-cell', '--purpose', 'keeps the shelves tidy');
  assert.equal(made.code, 0, made.err || made.out);
  for (const [path, text] of Object.entries(expected)) {
    assert.equal(readFileSync(join(box.repo, path), 'utf8'), text, path);
    assert.ok(made.out.split('\n').includes(path), `prints ${path}`);
  }
});

test('cli.io-commands-new.refuses-existing-package: clause 2: new package refuses NEW_PACKAGE_EXISTS and writes nothing when packages/<name> already exists [C7,#11426]', async () => {
  const box = e2e.project();
  await box.runLocal(box.repo, 'new', 'package', 'tidy-cell', '--purpose', 'keeps the shelves tidy');
  const spare = Object.keys(newPackageFiles('tidy-cell', 'x'))[0];
  const before = readFileSync(join(box.repo, spare), 'utf8');
  const again = await box.runLocal(box.repo, 'new', 'package', 'tidy-cell', '--purpose', 'a different purpose');
  assert.notEqual(again.code, 0);
  assert.match(again.err + again.out, /NEW_PACKAGE_EXISTS/u);
  assert.equal(readFileSync(join(box.repo, spare), 'utf8'), before, 'the existing file is untouched');
});

test('cli.io-commands-new.refuses-bad-usage: clause 3: new refuses USAGE for a first word other than package, or with no name [C7,#11426]', async () => {
  const box = e2e.project();
  for (const args of [['widget', 'tidy-cell'], ['package']]) {
    const refused = await box.runLocal(box.repo, 'new', ...args, '--purpose', 'x');
    assert.notEqual(refused.code, 0);
    assert.match(refused.err + refused.out, /USAGE/u);
  }
  assert.equal(existsSync(join(box.repo, 'packages', 'tidy-cell')), false);
});

const PLAN = 'packages/codemap/data/plan';

/** A fixture project holding one cell made by `new package`, with the plan row the lint needs, committed so the cell inventory sees it. */
function projectWithNewCell(name) {
  const box = e2e.project();
  const index = { version: 1, names: {}, cells: [{ order: 1, name, file: `${PLAN}/01-${name}.json` }], stays: [], retired: [], entries: [], engineStays: [], allowedEdges: [], upwardEdgesGrandfathered: [] };
  const shard = { order: 1, name, kind: 'package', root: `packages/${name}`, frontDoor: `packages/${name}/index.js`, pureFrontDoor: `packages/${name}/light.js`, paths: [], reexports: [], imports: [], cuts: [] };
  return { box, index, shard };
}

test('cli.io-commands-new.lints-cell-lint-report-clean: clause 1: a cell written by new package into a fixture project root has no finding for packages/<name> in cellLintReport [C7,#11430]', async () => {
  const { box, index, shard } = projectWithNewCell('tidy-cell');
  const made = await box.runLocal(box.repo, 'new', 'package', 'tidy-cell', '--purpose', 'keeps the shelves tidy');
  assert.equal(made.code, 0, made.err || made.out);
  for (const [path, body] of [[`${PLAN}/cells.json`, index], [`${PLAN}/01-tidy-cell.json`, shard]]) {
    mkdirSync(dirname(join(box.repo, path)), { recursive: true });
    writeFileSync(join(box.repo, path), JSON.stringify(body, null, 2) + '\n');
  }
  // The report reaches a package only from an application entry; the fixture's package.json names the new cell's front door as its bin.
  writeFileSync(join(box.repo, 'package.json'), JSON.stringify({ name: 'fixture-shop', version: '1.0.0', bin: { shop: 'packages/tidy-cell/index.js' } }, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: add the new cell and its plan row');
  const report = withCellLintParser(compile => cellLintReport(box.repo, cellLintParsers(compile)));
  const mine = [];
  for (const [metric, row] of Object.entries(report.metrics ?? {})) {
    for (const finding of row.findings) if (JSON.stringify(finding).includes('packages/tidy-cell')) mine.push(`${metric}: ${JSON.stringify(finding)}`);
  }
  for (const row of report.unknown ?? []) if (JSON.stringify(row).includes('packages/tidy-cell')) mine.push(`unknown: ${JSON.stringify(row)}`);
  assert.deepEqual(mine, []);
});

test('cli.io-commands-new.lints-generated-tests-pass: clause 2: the registry and inputs tests the generated cell carries pass when run with node --test on that fixture root [C7,#11430]', async () => {
  const box = e2e.project();
  const made = await box.runLocal(box.repo, 'new', 'package', 'tidy-cell', '--purpose', 'keeps the shelves tidy');
  assert.equal(made.code, 0, made.err || made.out);
  const tests = Object.keys(newPackageFiles('tidy-cell', 'x')).filter(path => /\/tests\/[^/]+\.test\.js$/u.test(path));
  assert.ok(tests.some(path => path.endsWith('inputs.test.js')) && tests.some(path => path.endsWith('registry.test.js')), tests.join());
  // node:test's own runner loads the generated files in its isolated children, so this test spawns nothing itself.
  const passed = [], failed = [];
  // Inside a node:test child the marker makes the grandchildren answer in a form the runner API does not read; hide it while they run.
  const marker = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    for await (const event of run({ files: tests.map(path => join(box.repo, path)), cwd: box.repo })) {
      if (event.type === 'test:pass') passed.push(event.data.name);
      if (event.type === 'test:fail') failed.push(`${event.data.name}: ${event.data.details?.error?.message ?? ''}`);
    }
  } finally {
    if (marker !== undefined) process.env.NODE_TEST_CONTEXT = marker;
  }
  assert.deepEqual(failed, []);
  assert.ok(passed.length >= tests.length, `ran ${passed.length} cases for ${tests.length} files`);
});
