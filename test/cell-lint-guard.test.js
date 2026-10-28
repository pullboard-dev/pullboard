/** @pullboard-test-input test-tree */
/** @pullboard-test-input source-tree */
/** Scan actual repository debt without private fixtures, native board access or browser launches [C7,CD64]. */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cellLintReport } from '../src/cell-lints.js';
import { cellLintGrowth } from '../src/cell-lint-ratchet.js';
import { readCellLintBaseline } from '../src/cell-lint-store.js';

// The analyzer compiles bounded source probes in Node children; it never executes repository modules.
test('the repository cell guard enforces strict debt and reports named transition rises [C7,CD64]', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const report = cellLintReport(root), baseline = readCellLintBaseline(root);
  const growth = cellLintGrowth(report, baseline);
  for (const row of growth.filter(row => row.advisory)) console.log(`advisory item #${row.item} until #${row.until}: ${row.metric}:${row.key}: ${row.actual} exceeds ${row.allowed}`);
  assert.deepEqual(cellLintGrowth(report, baseline, { enforcedOnly: true }), [], 'the mandatory source scanner keeps strict debt enforced without rewriting the baseline');
});
