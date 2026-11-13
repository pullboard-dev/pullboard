/** @pullboard-test-input source-tree */
import { flakyProject } from '../../../../packages/git/tests/fixtures/flakes.js';
import { TITLE } from '../../../../packages/git/tests/fixtures/flakes.js';
import { targetRuns } from '../../../../packages/git/tests/fixtures/flakes.js';
import { assertReceipts } from '../../../../packages/git/tests/fixtures/flakes.js';
import '../../tests/fixtures/cases/quarantine.js';
import { checkAtCommit } from '../../../runner/index.js';
/** @pullboard-test-input source-tree */
/** Native flake observations preserve the first red verdict and carry evidence into repair work [C7,D1,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { flakeSource } from '../../../../packages/flakes/index.js';
import { observeNativeFailure } from '../../../../packages/flakes/index.js';

const CI_ROOT = join(tmpdir(), 'pullboard-ci-runner', 'repo');

test('a ledger recording failure cannot replace the original red or discard its evidence [C7,H16]', async t => {
  const box = flakyProject(t, { rerun: false });
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  const pin = flakeSource(box.root);
  const result = runFixtureChild(process.execPath, ['--test', '--test-reporter=tap', 'test/alternating.test.mjs'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 1, 'the original assertion really failed before the forced recording error');
  const run = { isGreen: false, output: result.stdout + result.stderr };
  const notices = [];
  await observeNativeFailure({ root: box.root, config, pin, run, checkAtCommit, command: config.gate, kind: 'check',
    record: () => { throw Object.assign(new Error('private injected ledger failure'), { code: 'SYNTHETIC_LEDGER_UNAVAILABLE' }); },
    onError: notice => notices.push(notice),
  });
  assert.equal(run.isGreen, false);
  assert.equal(targetRuns(box), 1, 'a recording failure adds no execution');
  assert.equal(run.flakeDiagnostics.error, 'SYNTHETIC_LEDGER_UNAVAILABLE');
  assert.equal(run.flakeDiagnostics.observations[0].recorded, false, 'the result never claims the missing ledger entry was recorded');
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /original result stays red/u);
  const directory = join(box.root, '.git/pullboard/flake-evidence', run.flakeDiagnostics.observations[0].id);
  const retained = JSON.parse(readFileSync(join(directory, 'observation.json'), 'utf8'));
  assertReceipts(box, retained);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  for (const [file, digest] of Object.entries(manifest)) assert.equal(createHash('sha256').update(box.readData(join(directory, file))).digest('hex'), digest);
  assert.equal(Object.hasOwn(manifest, 'recording-error.addendum.json'), false, 'the original manifest remains immutable');
  assert.equal(JSON.parse(readFileSync(join(directory, 'recording-error.addendum.json'), 'utf8')).code, 'SYNTHETIC_LEDGER_UNAVAILABLE');
});

/** Save one CI attempt as the importer reads it: a manifest beside its TAP report. */
function ciAttempt(folder, name, manifest, tap) {
  const directory = join(folder, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'run.tap'), tap);
  writeFileSync(join(directory, 'ci-result.json'), JSON.stringify({ provider: 'github', root: CI_ROOT, tap: 'run.tap', ...manifest }));
}

test('a CI job red then green on its rerun is one flake, and a CI failure with no test names stays unclassified [C7,H16]', async t => {
  const box = flakyProject(t);
  const commit = box.git('rev-parse', 'HEAD').trim();
  const ci = join(box.scratch, 'ci-results');
  const location = `  location: '${CI_ROOT}/test/alternating.test.mjs:3:1'\n`;
  const job = { job: 'linux (22.13.1) 1/2', runner: 'ubuntu-24.04', node: 'v22.13.1', commit, at: '2026-10-20T10:00:00.000Z' };
  ciAttempt(ci, 'run-111-1', { ...job, run: '111', attempt: 1, conclusion: 'failure' }, `TAP version 13\nnot ok 1 - ${TITLE}\n  ---\n${location}  ...\n1..1\n`);
  ciAttempt(ci, 'run-111-2', { ...job, run: '111', attempt: 2, conclusion: 'success' }, `TAP version 13\nok 1 - ${TITLE}\n  ---\n${location}  ...\n1..1\n`);
  const crash = { job: 'macos (22.13.1) 2/2', runner: 'macos-15', node: 'v22.13.1', commit, at: '2026-10-20T11:00:00.000Z' };
  ciAttempt(ci, 'run-222-1', { ...crash, run: '222', attempt: 1, conclusion: 'failure' }, 'TAP version 13\nnot ok 1 - the shard stopped before its tests reported\n1..1\n');
  ciAttempt(ci, 'run-222-2', { ...crash, run: '222', attempt: 2, conclusion: 'success' }, 'TAP version 13\n1..0\n');

  const imported = await box.call('flakes', 'import', ci);
  assert.equal(imported.code, 0, JSON.stringify(imported.document));
  assert.equal(imported.document.imported.length, 2);
  const listed = (await box.call('flakes')).document;
  assert.equal(listed.flakes.length, 1, 'the red-then-green CI pair is one flake');
  const flake = listed.flakes[0].observations[0];
  assert.equal(listed.flakes[0].file, 'test/alternating.test.mjs', 'the CI location resolves inside the CI checkout');
  assert.equal(listed.flakes[0].name, TITLE);
  assert.equal(flake.kind, 'ci');
  assert.deepEqual(flake.ci, { provider: 'github', run: '111', attempt: 1, rerunAttempt: 2, job: job.job, runner: job.runner, node: job.node });
  assert.equal(flake.head, commit);
  assert.equal(flake.original.green, false, 'the original CI red is kept');
  assert.equal(flake.paired.green, true);
  assert.equal(flake.load, null, 'a hosted runner reports no host load, and none is invented');
  assertReceipts(box, flake);
  const unnamed = listed.unclassified.flatMap(row => row.observations).find(entry => entry.ci?.run === '222');
  assert.ok(unnamed, 'the CI failure with no test named by file is recorded');
  assert.equal(unnamed.file, null);
  assert.equal(unnamed.classification, 'unclassified');
  assert.match(unnamed.reason, /no test named by file/u);

  const again = await box.call('flakes', 'import', ci);
  assert.equal(again.code, 0);
  assert.ok(again.document.imported.every(entry => entry.duplicate), 'importing the same CI results again records nothing new');
  assert.equal((await box.call('flakes')).document.flakes[0].count, 1);
});

test('a CI rerun that names its passing test without a location still pairs, and kept CI evidence is never replaced [C7,H16]', async t => {
  const box = flakyProject(t);
  const commit = box.git('rev-parse', 'HEAD').trim();
  const ci = join(box.scratch, 'ci-results');
  const job = { job: 'linux (24) 2/2', runner: 'ubuntu-24.04', node: 'v24.11.0', commit, run: '444', at: '2026-10-20T12:00:00.000Z' };
  const red = `TAP version 13\nnot ok 1 - ${TITLE}\n  ---\n  location: '${CI_ROOT}/test/alternating.test.mjs:3:1'\n  ...\n1..1\n`;
  ciAttempt(ci, 'run-444-1', { ...job, attempt: 1, conclusion: 'failure' }, red);
  // As Node's TAP reporter writes it: a passing test carries no location.
  ciAttempt(ci, 'run-444-2', { ...job, attempt: 2, conclusion: 'success' }, `TAP version 13\nok 1 - ${TITLE}\n  ---\n  duration_ms: 1.2\n  ...\n1..1\n`);
  assert.equal((await box.call('flakes', 'import', ci)).code, 0);
  const flake = (await box.call('flakes')).document.flakes[0]?.observations[0];
  assert.equal(flake?.classification, 'flake', 'the rerun row matches by its name when it carries no location');
  const kept = join(box.root, '.git/pullboard', flake.original.artifact);
  const before = box.readData(kept);
  // The downloaded red report changes by one comment line; the ledger refuses it, and the kept original is untouched.
  writeFileSync(join(ci, 'run-444-1', 'run.tap'), red + '# re-downloaded\n');
  const changed = await box.call('flakes', 'import', ci);
  assert.equal(changed.code, 1);
  assert.equal(changed.document.error.code, 'FLAKE_OBSERVATION_CHANGED');
  assert.deepEqual(box.readData(kept), before, 'the original red evidence keeps its recorded bytes');
  assertReceipts(box, flake);
});


test('a CI passing title cannot prove two files when the other rerun skips [C7,H16]', async t => {
  const box = flakyProject(t);
  for (const suffix of ['a', 'b']) {
    writeFileSync(join(box.root, `test/ci-${suffix}.test.mjs`), `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('the shared title [C7]', { skip: process.env.CI_DUPLICATE_MODE === 'rerun' && ${suffix === 'b'} }, () => {
  assert.equal(process.env.CI_DUPLICATE_MODE, 'rerun');
});\n`);
  }
  box.git('add', 'test/ci-a.test.mjs', 'test/ci-b.test.mjs');
  box.git('commit', '-q', '-m', 'test: prepare fixed duplicate-title CI source');
  const commit = box.git('rev-parse', 'HEAD');
  const command = ['--test', '--test-reporter=tap', 'test/ci-a.test.mjs', 'test/ci-b.test.mjs'];
  const red = runFixtureChild(process.execPath, command, { cwd: box.root, env: { ...box.env, CI_DUPLICATE_MODE: 'red' }, encoding: 'utf8' });
  const rerun = runFixtureChild(process.execPath, command, { cwd: box.root, env: { ...box.env, CI_DUPLICATE_MODE: 'rerun' }, encoding: 'utf8' });
  t.diagnostic(JSON.stringify({ commit, node: process.version, red: red.stdout, rerun: rerun.stdout }));
  assert.equal(red.status, 1, red.failure);
  assert.equal(rerun.status, 0, rerun.failure);
  assert.match(red.stdout, /^# fail 2$/mu);
  assert.match(rerun.stdout, /^# pass 1$/mu);
  assert.match(rerun.stdout, /^# skipped 1$/mu);
  assert.equal(box.git('rev-parse', 'HEAD'), commit);
  assert.equal(box.git('status', '--porcelain'), '', 'the two attempts use identical committed source');
  const ci = join(box.scratch, 'ci-results');
  const job = { job: 'duplicate titles', runner: 'private-node-fixture', node: process.version, commit, root: box.root, run: '555', at: '2026-10-20T12:00:00.000Z' };
  ciAttempt(ci, 'red', { ...job, attempt: 1, conclusion: 'failure' }, red.stdout);
  ciAttempt(ci, 'rerun', { ...job, attempt: 2, conclusion: 'success' }, rerun.stdout);
  const imported = await box.call('flakes', 'import', ci);
  assert.equal(imported.code, 0, JSON.stringify(imported.document));
  const listed = (await box.call('flakes')).document;
  assert.equal(listed.flakes.length, 0, 'one anonymous pass cannot prove either of two same-title files green');
  assert.deepEqual(listed.unclassified.map(row => row.file).sort(), ['test/ci-a.test.mjs', 'test/ci-b.test.mjs']);
  for (const row of listed.unclassified) assertReceipts(box, row.observations[0]);
});

test('a CI rerun matches an explicit file before considering anonymous same-title rows [C7,H16]', async t => {
  const box = flakyProject(t);
  const commit = box.git('rev-parse', 'HEAD');
  const ci = join(box.scratch, 'ci-results');
  const job = { job: 'explicit and anonymous', runner: 'private-tap-fixture', node: process.version, commit, run: '666', at: '2026-10-20T12:00:00.000Z' };
  const row = (status, number, file) => `${status} ${number} - shared title [C7]\n  ---\n${file ? `  location: '${CI_ROOT}/${file}:3:1'\n` : ''}  ...\n`;
  ciAttempt(ci, 'red', { ...job, attempt: 1, conclusion: 'failure' }, `TAP version 13\n${row('not ok', 1, 'test/a.test.mjs')}${row('not ok', 2, 'test/b.test.mjs')}1..2\n`);
  ciAttempt(ci, 'rerun', { ...job, attempt: 2, conclusion: 'success' }, `TAP version 13\n${row('ok', 1, 'test/a.test.mjs')}${row('ok', 2, null)}1..2\n`);
  const imported = await box.call('flakes', 'import', ci);
  assert.equal(imported.code, 0, JSON.stringify(imported.document));
  const listed = (await box.call('flakes')).document;
  assert.deepEqual(listed.flakes.map(entry => entry.file), ['test/a.test.mjs'], 'the explicitly located passing row proves its own file');
  assert.deepEqual(listed.unclassified.map(entry => entry.file), ['test/b.test.mjs'], 'the anonymous row remains ambiguous');
});


test('a same-title skipped original does not lend its identity to an anonymous CI pass [C7,H16]', async t => {
  const box = flakyProject(t);
  const commit = box.git('rev-parse', 'HEAD');
  const ci = join(box.scratch, 'ci-results');
  const job = { job: 'original ambiguity', runner: 'private-tap-fixture', node: process.version, commit, run: '777', at: '2026-10-20T12:00:00.000Z' };
  ciAttempt(ci, 'red', { ...job, attempt: 1, conclusion: 'failure' }, `TAP version 13\nnot ok 1 - shared title [C7]\n  ---\n  location: '${CI_ROOT}/test/a.test.mjs:3:1'\n  ...\nok 2 - shared title [C7] # SKIP\n1..2\n`);
  ciAttempt(ci, 'rerun', { ...job, attempt: 2, conclusion: 'success' }, 'TAP version 13\nok 1 - shared title [C7]\n1..1\n');
  const imported = await box.call('flakes', 'import', ci);
  assert.equal(imported.code, 0, JSON.stringify(imported.document));
  const listed = (await box.call('flakes')).document;
  assert.equal(listed.flakes.length, 0, 'the anonymous pass could be the other original test');
  assert.deepEqual(listed.unclassified.map(entry => entry.file), ['test/a.test.mjs'], 'the skipped original is not itself recorded as a failure');
});

test('a duplicate original CI file and title cannot share one located passing occurrence [C7,H16]', async t => {
  const box = flakyProject(t);
  const commit = box.git('rev-parse', 'HEAD');
  const ci = join(box.scratch, 'ci-results');
  const job = { job: 'duplicate original identity', runner: 'private-tap-fixture', node: process.version, commit, run: '888', at: '2026-10-20T12:00:00.000Z' };
  const row = (status, number) => `${status} ${number} - shared title [C7]\n  ---\n  location: '${CI_ROOT}/test/shared.test.mjs:3:1'\n  ...\n`;
  ciAttempt(ci, 'red', { ...job, attempt: 1, conclusion: 'failure' }, `TAP version 13\n${row('not ok', 1)}${row('not ok', 2)}1..2\n`);
  ciAttempt(ci, 'rerun', { ...job, attempt: 2, conclusion: 'success' }, `TAP version 13\n${row('ok', 1)}1..1\n`);
  const imported = await box.call('flakes', 'import', ci);
  assert.equal(imported.code, 0, JSON.stringify(imported.document));
  const listed = (await box.call('flakes')).document;
  assert.equal(listed.flakes.length, 0, 'a located pass cannot identify which duplicate original occurrence passed');
  assert.deepEqual(listed.unclassified.map(entry => entry.file), ['test/shared.test.mjs']);
  assertReceipts(box, listed.unclassified[0].observations[0]);
});
