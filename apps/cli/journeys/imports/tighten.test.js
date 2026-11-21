/** The closure tighten script lowers budget rows to measured counts and never raises one [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lowerRows } from './tighten.js';
import { parseMeasured } from './tighten.js';

test('cli.journeys-imports-tighten.lowers-never-raises: clause 1: lowerRows lowers a row whose measured count is below its ceiling, keeps a row measured above it, keeps rows with no measurement and keeps key order [C7]', () => {
  const rows = { whoami: 227, 'show 1': 530, list: 265, status: 1331 };
  const lowered = lowerRows(rows, { whoami: 200, 'show 1': 600, status: 1331 });
  assert.deepEqual(lowered, { whoami: 200, 'show 1': 530, list: 265, status: 1331 });
  assert.deepEqual(Object.keys(lowered), Object.keys(rows));
});

test('cli.journeys-imports-tighten.parses-row-diagnostics: clause 2: parseMeasured reads row names with spaces and counts from TAP diagnostic lines in both the lower-its-budget and main-lowers-its-ceiling wordings [C7]', () => {
  const tap = [
    '    # pullboard show 1 loaded 480; lower its budget in closure-budget.json to 480',
    '    # pullboard runner-home whoami loaded 200; main lowers its ceiling in closure-budget.json to 200',
    '    # pullboard release 1 --reason OTHER --note x loaded 1000; lower its budget in closure-budget.json to 1000',
    '    # unrelated diagnostic line',
    'not ok 3 - pullboard list loaded 300 modules, over its budget of 265: never raise the budget',
  ].join('\n');
  assert.deepEqual(parseMeasured(tap), { 'show 1': 480, 'runner-home whoami': 200, 'release 1 --reason OTHER --note x': 1000 });
});
