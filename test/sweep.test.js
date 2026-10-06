/**
 * The sweep (N15): reading checkers' reports and turning them into one item per file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { briefFiles, briefSections } from '../src/brief.js';
import { parseProblems, sweepItems } from '../src/sweep.js';

const ROOT = '/repo';

test('reads ESLint JSON, with absolute paths made relative [N15]', () => {
  const report = JSON.stringify([
    { filePath: '/repo/web/a.js', messages: [{ line: 3, column: 5, ruleId: 'no-unused-vars', message: "'x' is unused." }] },
    { filePath: '/repo/web/b.js', messages: [] },
  ]);
  assert.deepEqual(parseProblems(`some banner\n${report}`, ROOT), [
    { file: 'web/a.js', line: 3, col: 5, rule: 'no-unused-vars', message: "'x' is unused." },
  ]);
});

test('reads TypeScript and file:line:col reports [N15]', () => {
  const text = [
    'src/store.ts(12,7): error TS2322: Type string is not assignable to type number.',
    './api/server.py:4:1: F401 os imported but unused',
    'lib/util.py:9: error: Missing return statement  [return]',
    'web/a.js:2:1: no-var Unexpected var, use let or const.',
    'src/a.js:3:1: camelcase Name variables in camelCase.',
    'src/a.js:4:9: unexpected token here',
    '/repo/web/b.js:7:3: Expected === and instead saw ==. [Error/eqeqeq]',
    'Found 3 errors.',
    'warning: something without a place',
  ].join('\n');
  assert.deepEqual(parseProblems(text, ROOT), [
    { file: 'src/store.ts', line: 12, col: 7, rule: 'TS2322', message: 'Type string is not assignable to type number.' },
    { file: 'api/server.py', line: 4, col: 1, rule: 'F401', message: 'os imported but unused' },
    { file: 'lib/util.py', line: 9, col: 0, rule: 'return', message: 'Missing return statement' },
    { file: 'web/a.js', line: 2, col: 1, rule: 'no-var', message: 'Unexpected var, use let or const.' },
    { file: 'src/a.js', line: 3, col: 1, rule: 'camelcase', message: 'Name variables in camelCase.' },
    { file: 'src/a.js', line: 4, col: 9, rule: '', message: 'unexpected token here' },
    { file: 'web/b.js', line: 7, col: 3, rule: 'eqeqeq', message: 'Expected === and instead saw ==.' },
  ]);
});

test('files one complete light item per file, most problems first, skipping covered files [N15, B14]', () => {
  const problems = [
    { file: 'web/a.js', line: 1, col: 1, rule: 'semi', message: 'Missing semicolon.' },
    { file: 'api/b.js', line: 2, col: 1, rule: 'eqeqeq', message: 'Expected ===.' },
    { file: 'api/b.js', line: 5, col: 3, rule: 'eqeqeq', message: 'Expected ===.' },
    { file: 'web/c.js', line: 1, col: 1, rule: 'semi', message: 'Missing semicolon.' },
    { file: '../outside.js', line: 1, col: 1, rule: 'semi', message: 'x' },
  ];
  const { items, skipped } = sweepItems(problems, {
    laneOf: (path) => path.split('/')[0],
    covered: new Set(['web/c.js']),
    check: 'npx eslint {file}',
    report: 'npx eslint -f json .',
    route: 'light',
    max: 5,
  });
  assert.deepEqual(items.map((item) => [item.title, item.lane, item.check]), [
    ['fix 2 problems in api/b.js', 'api', 'npx eslint api/b.js'],
    ['fix 1 problem in web/a.js', 'web', 'npx eslint web/a.js'],
  ]);
  assert.deepEqual(skipped, ['web/c.js']);
  const [first] = items;
  assert.deepEqual(briefFiles(first.brief), ['api/b.js']);
  assert.match(first.brief, /- line 5:3 eqeqeq: Expected ===\./);
  assert.ok(briefSections(first.brief).test.length);
  assert.match(first.brief, /Out of scope: every other file; disabling the rule; ignore or suppression comments/);
  assert.equal(sweepItems(problems, { laneOf: () => 'web', covered: new Set(), check: 'c {file}', report: 'r', route: 'light', max: 1 }).items.length, 1);
});
