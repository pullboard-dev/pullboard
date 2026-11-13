/**
 * Main's view coverage check follows the checked tree's path map: a test importing a moved body still covers the
 * module it covered before the move, and a moved module with no test still fails [N26,C7].
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENFORCED_FILE } from '../../src/io/static/view.js';
import { viewPureGate } from '../../src/io/static/view.js';

const TEST = 'apps/cli/journeys/view/example-pure.test.js', OLD = 'src/view/example-render.js', NEW = 'apps/view/src/logic/example/render.js';
const ROLES = { [TEST]: { kind: 'logic', reason: 'Seeded data through the actual renderer' } };
const COVERAGE = [{ module: OLD, names: ['exampleHtml'], tests: [TEST] }];

/** A private tree where the covered renderer moved to apps/view behind a shim, with its test repointed. */
function movedTree(t, { mapped = true, imported = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'view-pure-moved-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Write one private source file. */
  const put = (path, text) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  put(ENFORCED_FILE, JSON.stringify({ roots: [TEST] }));
  put(NEW, 'export function exampleHtml(input) { return input.title; }\n');
  put(OLD, "export { exampleHtml } from '../../apps/view/src/logic/example/render.js';\n");
  if (mapped) put('packages/codemap/data/plan/path-map/view.json', JSON.stringify({ [OLD]: NEW }));
  put(TEST, imported
    ? "import { exampleHtml } from '../../../../apps/view/src/logic/example/render.js';\nexampleHtml({ title: 'hi' });\n"
    : "export const unrelated = 1;\n");
  return root;
}

/** The witness failures the gate names for the moved module. */
const witnessFailures = root => viewPureGate(root, { roles: ROLES, coverage: COVERAGE }).failures
  .filter(finding => finding.text.includes('missing logic witness for exampleHtml'));

test('a test importing a moved body covers the module the path map moved [N26,C7]', t => {
  assert.deepEqual(viewPureGate(movedTree(t), { roles: ROLES, coverage: COVERAGE }).failures, []);
});

test('without the path map row, a test importing the moved body is no witness for the old path [N26,C7]', t => {
  assert.equal(witnessFailures(movedTree(t, { mapped: false })).length, 1);
});

test('a moved module with no test importing it still fails [N26,C7]', t => {
  assert.equal(witnessFailures(movedTree(t, { imported: false })).length, 1);
});
