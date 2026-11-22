/** A clean change passes submit preflight within the established bound [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runPreflight } from '../../../src/io/submit/preflight.js';

/** Build the minimal project whose clean source is checked by the production preflight. */
function preflightProject(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'bin/checks'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/gate/data/baselines'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/gate/data/baselines/test-waits-baseline.json'), '{}');
  mkdirSync(join(box.repo, 'packages/x/src'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/x/src/a.js'), 'export const a = 1;\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: base for the preflight');
  return box;
}

test('cli.journeys-submit-preflight.a-clean-change-passes-preflight-and: clause 2: a clean change passes preflight and it finishes under 15 seconds [C7]', { timeout: 120_000 }, async (t) => {
  const box = preflightProject(t);
  const report = await runPreflight(box.repo, ['packages/x/src/a.js']);
  assert.equal(report.ok, true, JSON.stringify(report.results.filter(row => row.failures.length)));
  assert.ok(report.ms < 15000, `preflight took ${Math.round(report.ms)} ms`); // budget: the criterion requires under 15 s.
});
