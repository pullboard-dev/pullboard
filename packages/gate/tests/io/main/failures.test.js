/** A red gate names only the failing cases with their first error line, plus any runner error, never a passing file [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { redGateReport } from '../../../index.js';
import { retainTestOutput } from '../../../index.js';

/**
 * Run real test files with node's TAP reporter in a scratch project, as a gate does, and return the output.
 * @param {string} root
 * @param {string[]} files
 */
function tap(root, files) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST')) delete env[name];
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: root, env, encoding: 'utf8' });
  return run.stdout;
}

/** A scratch project whose item check fails one case while the unit tier's files all pass. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-red-gate-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/check.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "test('the check case that holds', () => assert.equal(1, 1));",
    "test('the check case that breaks', () => assert.equal(2 + 2, 5, 'sum drifted from the bar'));",
  ].join('\n'));
  for (const name of ['unit-one', 'unit-two']) writeFileSync(join(root, `test/${name}.test.js`), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    `test('${name} stays green', () => assert.ok(true));`,
  ].join('\n'));
  const output = join(root, 'runs');
  return { root, output };
}

test('a gate whose item check fails one case while the unit tier passes reports exactly that case and its first error line [C7]', (t) => {
  const { root, output } = fixture(t);
  const log = tap(root, ['test/check.test.js']) + tap(root, ['test/unit-one.test.js', 'test/unit-two.test.js']);
  const summary = retainTestOutput(root, log, { root, directory: output });
  const gate = { check: { checked: true, green: false },
    testTiers: { units: ['test/unit-one.test.js', 'test/unit-two.test.js'], journeys: [], skipped: [] } };
  const report = redGateReport(gate, summary);
  assert.match(report, /^item check red; T1 unit tests: 2 ran/u);
  const failures = report.split('\n').filter(line => /: the check case/u.test(line));
  assert.equal(failures.length, 1, `exactly one failing case is named:\n${report}`);
  assert.match(failures[0], /check\.test\.js: the check case that breaks: sum drifted from the bar$/u, 'the case names its file and first error line');
  for (const passing of ['unit-one', 'unit-two', 'stays green', 'the check case that holds']) {
    assert.doesNotMatch(report, new RegExp(passing, 'u'), `the red report never names passing ${passing}`);
  }
  assert.match(report, /full log: /u);
});

test('a red affected run names only its failing file, and keeps a runner error the cases do not show [C7]', (t) => {
  const { root, output } = fixture(t);
  const log = tap(root, ['test/check.test.js', 'test/unit-one.test.js', 'test/unit-two.test.js'])
    + '# run-tests: could not remove the job tmp folder: ENOTEMPTY: directory not empty, rmdir \'/tmp/job\'\n';
  const summary = retainTestOutput(root, log, { root, directory: output });
  const gate = { check: { checked: true, green: true }, deferred: true,
    files: ['test/check.test.js', 'test/unit-one.test.js', 'test/unit-two.test.js'] };
  const report = redGateReport(gate, summary, { sections: ['', 'cross-lane mechanical edits: docs/a.md'] });
  assert.match(report, /^item check green; affected tests: 3 ran, failing: test\/check\.test\.js; .*full suite deferred to the landing gate$/mu);
  assert.match(report, /^cross-lane mechanical edits: docs\/a\.md$/mu, 'a section the caller already reports is kept');
  assert.match(report, /the check case that breaks: sum drifted from the bar/u);
  assert.match(report, /^run-tests: could not remove the job tmp folder: ENOTEMPTY/mu, 'the runner error is reported');
  for (const passing of ['unit-one', 'unit-two', 'stays green', 'the check case that holds']) {
    assert.doesNotMatch(report, new RegExp(passing, 'u'), `the red report never names passing ${passing}`);
  }
});
