/** @pullboard-test-input apps/cli/tests/fixtures/landing/ports.js apps/lib/index.js apps/lib/src/io/landing/candidate.js apps/runner/index.js packages/config/index.js packages/landing/index.js packages/store/index.js */
/** Known-main red accounting: cancellation accounting and the failing-file isolation the landing diagnosis uses [B3,C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { requireLocalGuardClassification } from '../../../../../packages/landing/index.js';
import { diagnose } from '../../../../../packages/landing/index.js';
import { completeGate } from '../../../../../packages/landing/index.js';
import { failureSignatures } from '../../../../../packages/landing/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject } = makeLandProjectFixtures({ sandbox, project, commitFile });
const MAIN_RED = 'web/land-9.test.js';

test('known-main cancellation accounting excludes only fully accounted cancellations [B3,C7]', () => {
  const root = '/fixture';
  const output = [
    'TAP version 13', '# Subtest: broken', 'not ok 1 - broken', '  ---',
    '  location: /fixture/test/example.test.js:1:1', '  failureType: testCodeFailure', '  error: assertion failed', '  ...',
    '# Subtest: cancelled', 'not ok 2 - cancelled', '  ---',
    '  location: /fixture/test/example.test.js:2:1', '  failureType: cancelledByParent', '  error: pending promise', '  ...',
    '1..2', '# tests 2', '# pass 0', '# fail 1', '# cancelled 1', '',
  ].join('\n');
  const run = { isGreen: false, output, stages: [{ status: 1, output }] };
  const allowed = { allowCancelled: true };
  assert.equal(completeGate({ complete: true }, allowed), true, 'native positive completion remains sufficient');
  assert.equal(completeGate({ complete: false }, allowed), false, 'negative metadata without a raw account never permits landing');
  assert.equal(completeGate(run), false);
  assert.equal(failureSignatures(run, root), null);
  assert.equal(completeGate(run, allowed), true);
  assert.deepEqual(failureSignatures(run, root, allowed).map(row => [row.file, row.name]), [['test/example.test.js', 'broken']]);
  const interrupted = `${output}Interrupted test files: test/other.test.js\n`;
  assert.equal(completeGate({ ...run, output: interrupted }, allowed), false);
  assert.equal(failureSignatures({ ...run, stages: [{ status: 1, output: interrupted }] }, root, allowed), null);
  const wrongCount = output.replace('# cancelled 1', '# cancelled 2');
  assert.equal(completeGate({ ...run, output: wrongCount }, allowed), false);
  assert.equal(failureSignatures({ ...run, stages: [{ status: 1, output: wrongCount }] }, root, allowed), null);
  assert.equal(failureSignatures({ ...run, stages: [{ status: 2, output }] }, root, allowed), null);
});

/** A separate-publish landing project whose main already carries one red case, committed and pushed through real hooks. */
function redMainProject() {
  const box = landProject({ withWorktree: false });
  box.env.PULLBOARD_MODEL = 'landing-fixture';
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const projectConfig = { ...config, landing: { perItem: false, manualOverride: true, publish: 'separate' } };
  writeFileSync(path, JSON.stringify(projectConfig, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    assert.equal(commitFile(box, box.repo, MAIN_RED, '// RED NAME:main-red-case\n', 'test(web): a case red on main [G1]').status, 0);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  return box;
}

test('an observer error without observations isolates each failing file once; recorded evidence is reused [B3,C7]', async t => {
  const box = redMainProject();
  // diagnose runs in this process: it takes its slot from the fixture's machine, never the real runner pool.
  const saved = Object.fromEntries(['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, { PULLBOARD_HOME: box.env.PULLBOARD_HOME, PULLBOARD_MACHINE_HOME: box.env.PULLBOARD_MACHINE_HOME });
  const state = {
    config: { flakes: { rerun: true }, affectedTests: box.affected },
    batch: { root: box.repo, logPath: join(box.dir, 'diagnostic.log'), revision: 0 },
    diagnosed: new Map(),
    write: async (_operation, [options]) => options.batch,
  };
  const failures = [{ file: MAIN_RED, name: 'main-red-case' }, { file: MAIN_RED, name: 'another case' }];
  assert.doesNotThrow(() => requireLocalGuardClassification(state, { flakeDiagnostics: { error: 'observer failed', observations: [] } }),
    'the local-trunk boundary permits the same isolate fallback');
  assert.throws(() => requireLocalGuardClassification(state, { flakeDiagnostics: { observations: [] } }), { code: 'LAND_DIAGNOSTIC' });
  const callsBefore = readFileSync(box.calls, 'utf8').trim().split('\n').length;
  const result = await diagnose(state, failures, { flakeDiagnostics: { error: 'observer failed', observations: [] } });
  assert.deepEqual(result, [], 'the reproducible red remains attributable');
  const callsAfter = readFileSync(box.calls, 'utf8').trim().split('\n').slice(callsBefore).map(JSON.parse);
  assert.deepEqual(callsAfter, [['--alone', MAIN_RED]], 'duplicate failures run the file once');
  // A recorded flake observation is the flake itself, reused as is (#2914); nothing refuses or isolates again.
  assert.deepEqual(await diagnose(state, failures, { logPath: box.calls, flakeDiagnostics: {
    error: 'observer failed', observations: [{ file: MAIN_RED, recorded: true, classification: 'flake' }],
  } }), [MAIN_RED]);
  assert.equal(readFileSync(box.calls, 'utf8').trim().split('\n').length, callsBefore + 1, 'recorded evidence triggers no extra isolation');
});
