/** @pullboard-test-input source-cell gate */
/** The tier-overruns script lists the test files whose recorded time is over their tier limit [C7,#11418]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { fixtureCommitAll } from '../../../fixtures/testkit.js';
import { TIER_TABLE } from '../../../../../commits/light.js';
import { tierOverruns } from '../../../../src/io/test/scripts/tier-overruns.js';
import { tierOverrunsReport } from '../../../../src/io/test/scripts/tier-overruns.js';

/** A private git repository holding a tier manifest and, when `times` is given, a landing file time record. */
function repo(t, files, times) {
  const box = privateFixtureFiles('pullboard-tier-overruns-');
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  box.write(`repo/${TIER_TABLE}`, JSON.stringify({ version: 1, files }));
  fixtureCommitAll(`${box.root}/repo`);
  if (times) box.write('repo/.git/pullboard/landing-file-times.json', JSON.stringify({ version: 1, files: times }));
  return `${box.root}/repo`;
}

const FILES = [
  { file: 'a.test.js', tier: 'T1' }, { file: 'b.test.js', tier: 'T1' }, { file: 'c.test.js', tier: 'T1' },
  { file: 'd.test.js', tier: 'T2' }, { file: 'e.test.js', tier: 'T2' },
  { file: 'f.test.js', tier: 'T3' }, { file: 'g.test.js', tier: 'T3' }, { file: 'h.test.js', tier: 'T3' },
];
const TIMES = { 'a.test.js': 30_001, 'b.test.js': 30_000, 'd.test.js': 60_500, 'e.test.js': 59_000, 'f.test.js': 120_001, 'g.test.js': 119_999 };

test('gate.io-test-scripts-tier-overruns.lists-files-over-limit: clause 1: tierOverruns returns the rows over their tier limit with per-tier counts, and lists files with no recorded time apart [C7,#11418]', () => {
  const { over, counts, unmeasured } = tierOverruns({ files: FILES, times: TIMES });
  assert.deepEqual(over, [
    { file: 'a.test.js', tier: 'T1', durationMs: 30_001, limitMs: 30_000 },
    { file: 'd.test.js', tier: 'T2', durationMs: 60_500, limitMs: 60_000 },
    { file: 'f.test.js', tier: 'T3', durationMs: 120_001, limitMs: 120_000 },
  ], 'exactly the rows over their limit; a time equal to the limit is not over');
  assert.deepEqual(counts, { T1: 1, T2: 1, T3: 1 });
  assert.deepEqual(unmeasured, ['c.test.js', 'h.test.js'], 'a file with no time is unmeasured and never over');
});

test('gate.io-test-scripts-tier-overruns.report-prints-rows: clause 2: tierOverrunsReport prints one line per over-limit file and the count line, and says no file times recorded with exit 1 when the root has no record [C7,#11418]', t => {
  const report = tierOverrunsReport([repo(t, FILES, TIMES)]);
  assert.equal(report.code, 0, report.stderr);
  assert.deepEqual(report.stdout.split('\n'), [
    'T1 a.test.js 30001 ms over 30000 ms',
    'T2 d.test.js 60500 ms over 60000 ms',
    'T3 f.test.js 120001 ms over 120000 ms',
    'T1 1, T2 1, T3 1, unmeasured 2',
    '',
  ]);
  const none = tierOverrunsReport([repo(t, FILES)]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no file times recorded/u);
});
