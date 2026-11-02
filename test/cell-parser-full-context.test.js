import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { requireSubmitCells } from '../bin/cells-submit-checks.js';
import { withMainCheckout } from '../packages/landing/index.js';
import { importsIn, commonJsIn } from '../src/module-imports.js';
import { withImportParseCache } from '../src/module-import-cache.js';
import { foreignNodeOptions } from '../src/test-isolation.js';
import { git } from '../src/git.js';

test('full source cell analysis completes under runner custody [C7,P3]', { timeout: 650_000 }, async () => {
  const root = process.cwd();
  const main = git(root, ['merge-base', 'HEAD', 'refs/heads/main']);
  const source = git(root, ['rev-parse', 'HEAD']);
  const result = await requireSubmitCells(root, main, source, { item_frozen: JSON.stringify({ criterion: 'full-context parser custody proof' }) }, {
    withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
    cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS), readCutItems: () => [],
    onInventory: mode => process.stdout.write(`full-context inventory: ${mode}\n`),
  });
  assert.equal(result.acceptedMain, main);
  assert.equal(result.source, source);
  assert.ok(Array.isArray(result.cells));
});
