/** A red gate's comparison with main reports gate progress while it runs, and nothing outside a driven gate [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../gate/tests/fixtures/child.js';
import { fixtureProjectPolicy } from '../../../../../gate/tests/fixtures/testkit.js';
import { withGateProgress } from '../../../../../gate/index.js';
import { compareMainFailures } from '../../../../index.js';

/** A real repository whose committed main has a Pullboard policy and no focused test runner. */
function repository() {
  const files = privateFixtureFiles('pullboard-main-progress-');
  runFixtureGit(['-C', files.root, 'init', '-q', '-b', 'main']);
  fixtureProjectPolicy(files.root, { config: { gate: 'true' } });
  runFixtureGit(['-C', files.root, 'add', '-A']);
  runFixtureGit(['-C', files.root, '-c', 'user.email=m@example.test', '-c', 'user.name=M', 'commit', '-qm', 'main']);
  return { root: files.root, commit: runFixtureGit(['-C', files.root, 'rev-parse', 'HEAD']) };
}

test('landing.progress.inside-a-driven-gate-a-comparison: clause 1: inside a driven gate, a comparison with main reports the gate running while it runs [C7]', async () => {
  const { root, commit } = repository();
  const reports = [];
  let settled = false;
  const comparison = await withGateProgress(detail => { reports.push({ ...detail, settled }); }, () => compareMainFailures(root, { tests: [{ file: 'test/a.test.js', passed: false }] }, () => {}, '', { commit, runnerAdmission: {} }));
  settled = true;
  assert.equal(comparison.main, commit);
  assert.ok(reports.some(report => report.running === true && report.settled === false), `the comparison reported the gate running before it ended: ${JSON.stringify(reports)}`);
});

test('landing.progress.outside-a-driven-gate-the-comparison: clause 2: outside a driven gate the comparison runs as before and reports nothing [C7]', async () => {
  const { root, commit } = repository();
  const comparison = await compareMainFailures(root, { tests: [{ file: 'test/a.test.js', passed: false }] }, () => {}, '', { commit, runnerAdmission: {} });
  assert.equal(comparison.main, commit);
  assert.equal(comparison.unavailable, 'no focused test runner configured');
});
