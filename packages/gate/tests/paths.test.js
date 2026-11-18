/** Receipts, run logs and failure lines name a test file by its full repository path, and two same-named files stay distinct [V32,V33]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from './fixtures/child.js';
import { redGateScope } from '../index.js';
import { renderTestSummary } from '../index.js';
import { testOutputSummary } from '../index.js';
import { timingDigest } from '../index.js';

const A = 'packages/alpha/tests/gate.test.js';
const B = 'packages/beta/tests/gate.test.js';

/** A TAP block for one failed case; a location line names the file when the reporter wrote one. */
function failedCase(number, name, location) {
  return `not ok ${number} - ${name}\n  ---\n  duration_ms: 1\n${location ? `  location: '${location}'\n` : ''}  failureType: 'testCodeFailure'\n  error: 'boom ${number}'\n  code: 'ERR_TEST_FAILURE'\n  ...\n`;
}

/** A private folder removed when the test ends. */
function folder(t) {
  const box = privateFixtureFiles('pullboard-full-paths-');
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  return box;
}

/** Summarize a retained log; the outcomes name each failed case's file when TAP does not. */
function summarize(t, tap, outcomes) {
  const box = folder(t);
  box.write('output.log', `TAP version 13\n${tap}1..2\n# tests 2\n# pass 0\n# fail 2\n# skipped 0\n`);
  return testOutputSummary(`${box.root}/output.log`, { root: box.root, profile: outcomes ? { testOutcomes: outcomes } : undefined });
}

/** The lines of a rendered summary that name a failed case. */
function failureLines(summary) {
  return renderTestSummary(summary).split('\n').filter(line => /: (?:works|boom)/u.test(line));
}

test('gate.paths.reporter-location-prints-full-repository: a reporter location prints as the full repository path, never the bare file name [V32,V33]', t => {
  const box = folder(t);
  box.write('output.log', `TAP version 13\n${failedCase(1, 'works', `${box.root}/${A}:3:1`)}${failedCase(2, 'works', `${box.root}/${B}:9:1`)}1..2\n# tests 2\n# pass 0\n# fail 2\n# skipped 0\n`);
  const summary = testOutputSummary(`${box.root}/output.log`, { root: box.root });
  assert.deepEqual(summary.failures.map(row => row.file), [A, B]);
  assert.match(renderTestSummary(summary), new RegExp(`^${A.replaceAll('.', '\\.')}: works`, 'mu'));
});

test('gate.paths.two-same-titled-failures-without: two same-titled failures without a located file are never given either path by guess [V32,V33]', t => {
  const summary = summarize(t, failedCase(1, 'works') + failedCase(2, 'works'), [
    { file: A, name: 'works', passed: false, skipped: false }, { file: B, name: 'works', passed: false, skipped: false }]);
  assert.deepEqual(summary.failures.map(row => row.file), [null, null]);
  assert.match(renderTestSummary(summary), /\(file unavailable\): works/u);
});

test('gate.paths.timing-digest-ranks-two-same: the timing digest ranks two same-named files by full path [V32,V33]', () => {
  const digest = timingDigest({ wallMs: 3000, waitMs: 0, files: [{ path: A, durationMs: 2000 }, { path: B, durationMs: 1000 }] });
  assert.ok(digest.includes(`  ${A}: 2.00s`) && digest.includes(`  ${B}: 1.00s`), digest);
  assert.ok(digest.split('\n').every(line => !/^\s+gate\.test\.js/u.test(line)));
});

test('gate.paths.red-gate-names-both-failing: a red gate names both failing same-named files by full path [V32,V33]', t => {
  const box = folder(t);
  box.write('output.log', `TAP version 13\n${failedCase(1, 'works', `${box.root}/${A}:3:1`)}${failedCase(2, 'works', `${box.root}/${B}:9:1`)}1..2\n# tests 2\n# pass 0\n# fail 2\n# skipped 0\n`);
  const summary = testOutputSummary(`${box.root}/output.log`, { root: box.root });
  assert.ok(redGateScope({ files: [A, B] }, summary).includes(`failing: ${A}, ${B}`));
});
