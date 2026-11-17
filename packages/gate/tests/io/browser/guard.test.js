/** @pullboard-test-input test-tree */
/** @pullboard-test-input source-tree */
/** Scan actual repository debt without private fixtures, native board access or browser launches [C7,CD64]. */
import { importsIn } from '../../../index.js';
import { commonJsIn } from '../../../index.js';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cellLintReport } from '../../../../codemap/index.js';
import { cellLintGrowth } from '../../../../codemap/index.js';
import { readCellLintBaseline } from '../../../../codemap/index.js';

// The analyzer compiles bounded source probes in Node children; it never executes repository modules.
test('gate.io-browser-guard.the-repository-cell-guard-enforces-strict: the repository cell guard enforces strict debt and reports named transition rises [C7,CD64]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const report = cellLintReport(root, { importsIn, commonJsIn }), baseline = readCellLintBaseline(root);
  const growth = cellLintGrowth(report, baseline);
  for (const row of growth.filter(row => row.advisory)) console.log(`advisory item #${row.item} until #${row.until}: ${row.metric}:${row.key}: ${row.actual} exceeds ${row.allowed}`);
  assert.deepEqual(cellLintGrowth(report, baseline, { enforcedOnly: true }), [], 'the mandatory source scanner keeps strict debt enforced without rewriting the baseline');
});
