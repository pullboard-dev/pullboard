/** The cells and route commands each print --json in the documented catalog shape [A1,C7,#8842]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { assertRequiredShape } from '../../../fixtures/api.js';
import { JSON_SHAPES } from '../../../../../../packages/config/index.js';

/** Run one command with --json in a fresh project, check the one document against its catalog entry, and return it. */
async function documented(t, command, args) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const result = await box.runLocal(box.repo, command, ...args, '--json');
  assert.equal(result.code ?? result.status, 0, `${command}: ${result.err ?? result.stderr}${result.out ?? result.stdout}`);
  const document = JSON.parse(result.out ?? result.stdout);
  assert.equal(document.version, 1, `${command} --json has a version 1 envelope`);
  assert.ok(JSON_SHAPES.commands[command], `JSON_SHAPES.commands documents ${command}`);
  assertRequiredShape(document, JSON_SHAPES.commands[command].required, command);
  return document;
}

test('cli.journeys-publish-catalog-cells-route.cells-runs-as-a-real-cli: clause 1: cells runs as a real CLI case and its JSON matches JSON_SHAPES.commands [A1,C7]', async t => {
  const report = await documented(t, 'cells', []);
  assert.ok(Array.isArray(report.cells), 'cells lists every cell');
  assert.deepEqual(report.unsealed, report.cells.filter(row => row.state === 'unsealed').map(row => row.cell), 'unsealed names the unsealed cells');
});

test('cli.journeys-publish-catalog-cells-route.route-runs-as-a-real-cli: clause 2: route runs as a real CLI case and its JSON matches JSON_SHAPES.commands [A1,C7]', async t => {
  const report = await documented(t, 'route', ['--suggest']);
  assert.equal(report.suggest, 'light');
  assert.ok(Array.isArray(report.items), 'route lists the strong items that meet the light shape');
});
