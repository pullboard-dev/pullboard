/** releaseFixture initialises once per option set and copies that template for every later case [C7,#9122]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseFixture } from '../../tests/fixtures/resume/release.js';
import { releaseInitRuns } from '../../tests/fixtures/resume/release.js';

const OPTIONS = { changelog: '# Changelog\n\n## [0.8.7] - 2026-10-12\n\n### Template once\n\nThe template fixture paragraph.\n' };

test('clause 1: two releaseFixture calls with the same options run the copied CLI\'s init once [C7,#9122]', t => {
  const before = releaseInitRuns();
  const first = releaseFixture(t, OPTIONS);
  const second = releaseFixture(t, OPTIONS);
  assert.notEqual(first.root, second.root);
  assert.equal(releaseInitRuns() - before, 1, 'init ran once for both fixtures');
  releaseFixture(t, { ...OPTIONS, freshSetup: true });
  assert.equal(releaseInitRuns() - before, 2, 'different options get their own template');
});

test('clause 2: the second fixture\'s repo answers resume with exit 0 like a freshly initialised one [C7,#9122]', t => {
  releaseFixture(t, OPTIONS);
  const second = releaseFixture(t, OPTIONS);
  const resumed = second.run(second.repo, 'resume');
  assert.equal(resumed.status, 0, resumed.failure || resumed.stderr || resumed.stdout);
  assert.ok(!(resumed.stdout + resumed.stderr).includes('pullboard-resume-template-'), 'resume never names the template root');
});
