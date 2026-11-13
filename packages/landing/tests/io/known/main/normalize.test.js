/** @pullboard-test-input packages/gate/tests/fixtures/known-main-red/identities.json */
/** Real failures retain assertion meaning while source refs, SHAs and temporary identities vary [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { failureSignatures } from '../../../../index.js';
import { matchingMainFailures } from '../../../../index.js';
import { normalizedFailureDiagnostics } from '../../../../index.js';
import { runFixtureChild } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../../apps/cli/tests/fixtures/child.js';

/** Commit a real private test, then retain the actual failing TAP with that repository's source identity. */
function failure(t, { message = 'same assertion', expected = 2, leaf = 'state.json' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-signature-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'identity.txt'), randomUUID());
  writeFileSync(join(root, 'test/failure.test.js'), `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('source-bound assertion [V4,B3]', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-signature-child-'));
  try {
    assert.equal(1, ${expected}, ${JSON.stringify(message)} + '; path ' + join(directory, ${JSON.stringify(leaf)})
      + '; source ' + process.env.FIXTURE_HEAD + '; short ' + process.env.FIXTURE_HEAD.slice(0, 12) + '; ref ' + process.env.FIXTURE_REF);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});\n`);
  /** All fixture Git operations use an explicit local identity, never the user's configuration. */
  const git = (...args) => runFixtureGit(['-c', 'user.name=Signature Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'test: native signature fixture');
  const source = git('rev-parse', 'HEAD'), ref = 'refs/pullboard/items/1/' + source.slice(0, 12);
  git('update-ref', ref, source);
  const env = { ...process.env, FIXTURE_HEAD: source, FIXTURE_REF: ref };
  delete env.NODE_TEST_CONTEXT;
  const run = runFixtureChild(process.execPath, ['--test', '--test-reporter=tap', 'test/failure.test.js'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const failures = failureSignatures({ isGreen: false, stages: [{ status: run.status, output: run.stdout }] }, root);
  assert.equal(failures?.length, 1, run.stdout + run.stderr);
  return { failures, source, ref, output: run.stdout };
}

/** Compare against an exact pinned main account, not a file-wide failure allowance. */
function matches(candidate, baseline) {
  const main = 'a'.repeat(40);
  return matchingMainFailures(candidate.failures, { main, files: [{ file: baseline.failures[0].file, result: 'red', failures: baseline.failures }] }, main);
}

test('real source SHA, abbreviated SHA, ref and temporary path changes preserve the same assertion signature [V4,B3,C7]', t => {
  const baseline = failure(t), candidate = failure(t);
  assert.notEqual(candidate.source, baseline.source, 'real commits differ');
  assert.notEqual(candidate.ref, baseline.ref, 'real Git refs differ');
  assert.notEqual(candidate.output, baseline.output, 'the native diagnostic bytes remain distinct');
  assert.ok(matches(candidate, baseline), 'only recognized runtime source identities differ');
  for (const options of [{ message: 'different assertion' }, { expected: 3 }, { leaf: 'different-state.json' }]) {
    assert.equal(matches(failure(t, options), baseline), null, JSON.stringify(options) + ' must remain a distinct failure');
  }
});

test('source normalization preserves identity relationships and unrelated hexadecimal values [V4,B3,C7]', () => {
  const hash = 'a'.repeat(40), other = 'b'.repeat(40);
  const normalize = text => normalizedFailureDiagnostics(['error: ' + text], '/fixture');
  assert.notDeepEqual(normalize('source ' + hash + ' source ' + hash), normalize('source ' + hash + ' source ' + other));
  assert.notDeepEqual(normalize('ref refs/heads/one ref refs/heads/one'), normalize('ref refs/heads/one ref refs/heads/two'));
  assert.notDeepEqual(normalize('a'.repeat(64)), normalize('b'.repeat(64)), '64-hex digests are not source SHAs');
  assert.notDeepEqual(normalize('a'.repeat(11)), normalize('b'.repeat(11)), 'unrecognized short tokens remain literal');
  assert.notDeepEqual(normalize('expected 2; actual 1'), normalize('expected 3; actual 1'));
  for (const field of ['expected', 'actual', 'left', 'right']) {
    assert.notDeepEqual(normalizedFailureDiagnostics([field + ': ' + hash], '/fixture'), normalizedFailureDiagnostics([field + ': ' + other], '/fixture'));
    assert.notDeepEqual(normalizedFailureDiagnostics([field + ': refs/heads/main'], '/fixture'), normalizedFailureDiagnostics([field + ': refs/heads/trunk'], '/fixture'));
  }
  for (const length of [12, 40]) {
    assert.notDeepEqual(normalize('1'.repeat(length)), normalize('2'.repeat(length)), 'bare decimal assertion values stay literal');
    assert.deepEqual(normalize('source ' + '1'.repeat(length)), normalize('source ' + '2'.repeat(length)), 'labeled numeric-only Git IDs are valid source identities');
    for (const field of ['expected', 'actual']) assert.notDeepEqual(normalizedFailureDiagnostics([field + ': ' + '1'.repeat(length)], '/fixture'), normalizedFailureDiagnostics([field + ': ' + '2'.repeat(length)], '/fixture'));
  }
  assert.notDeepEqual(normalize('ref refs/heads/one'), normalize('ref refs/tags/one'), 'ref namespaces retain meaning');
});

/** Wrap retained historical bytes only for parser coverage; no native execution is claimed here. */
function retained(row, block = row.block) {
  const output = 'TAP version 13\n' + block.replace(/^not ok \d+/u, 'not ok 1')
    + '\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n';
  const failures = failureSignatures({ isGreen: false, executionRoot: row.executionRoot, executionRunner: 'retained-parser-fixture',
    stages: [{ status: 1, output }] }, row.executionRoot);
  assert.equal(failures?.length, 1, 'the retained native diagnostic remains fully accounted');
  return { failures };
}

test('original paired waiver-summary failure matches source identities without discarding its assertion [V4,B3,C7]', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../../gate/tests/fixtures/known-main-red/identities.json', import.meta.url), 'utf8'));
  const baseline = retained(fixture.runs[0]), candidate = retained(fixture.runs[1]);
  assert.ok(matches(candidate, baseline));
  const different = retained(fixture.runs[1], fixture.runs[1].block.replace('the submission names the waiver, its reason and its expiry', 'a different missing authorization assertion'));
  assert.equal(matches(different, baseline), null, 'a substantive diagnostic difference remains blocking');
});
