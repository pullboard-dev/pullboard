/** Known-main matching discards runtime noise without granting a file-wide exemption [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { failureSignatures, matchingMainFailures, cachedFailureSignatures, MAIN_FAILURE_SIGNATURE_VERSION } from '../src/main-failure-matches.js';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';

/** A real committed private test generates a nested failing child with native elapsed/path/UUID/port diagnostics. */
function realFailure(t, { assertion = 'same assertion', expected = 0, name = 'volatile native failure [V4]', leaf = 'state.json' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-known-main-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  const child = `import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const root = mkdtempSync(join(tmpdir(), 'pullboard-known-child-'));
try { throw new Error(${JSON.stringify(assertion)} + ' file ' + join(root, ${JSON.stringify(leaf)}) + ' request ' + randomUUID() + ' endpoint http://127.0.0.1:' + port); }
finally { rmSync(root, { recursive: true, force: true }); }`;
  const helper = pathToFileURL(join(import.meta.dirname, 'fixture-child.js')).href;
  writeFileSync(join(root, 'test/failure.test.js'), `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFixtureChild } from ${JSON.stringify(helper)};
test(${JSON.stringify(name)}, () => {
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(child)}], { encoding: 'utf8' });
  assert.equal(result.status, ${expected}, result.context);
});\n`);
  runFixtureGit(['init', '-q'], { cwd: root });
  runFixtureGit(['-c', 'user.name=Private Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '.'], { cwd: root });
  runFixtureGit(['-c', 'user.name=Private Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--signoff', '-qm', 'test: private known main fixture'], { cwd: root });
  const run = runFixtureChild(process.execPath, ['--test', '--test-reporter=tap', 'test/failure.test.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1, 'the actual assertion fails rather than an import or setup problem');
  const failures = failureSignatures({ isGreen: false, stages: [{ status: run.status, output: run.stdout }] }, root);
  assert.equal(failures?.length, 1, run.stdout + run.stderr);
  assert.equal(failures[0].name, name);
  return { root, output: run.stdout, failures };
}

/** Only parser-unit reports are synthesized here; all diagnostic blocks remain retained historical bytes. */
function retainedRun(blocks, root) {
  const output = 'TAP version 13\n' + blocks.map((block, index) => block.replace(/^not ok \d+/u, 'not ok ' + (index + 1))).join('\n')
    + `\n1..${blocks.length}\n# tests ${blocks.length}\n# pass 0\n# fail ${blocks.length}\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  return failureSignatures({ isGreen: false, executionRoot: root, executionRunner: 'retained-unit-fixture', stages: [{ status: 1, output }] }, root);
}

/** Compare the exact candidate failures with a pinned main file account. */
function compare(candidate, mainFailures) {
  const main = 'a'.repeat(40);
  return matchingMainFailures(candidate, { main, files: [{ file: candidate[0].file, result: 'red', failures: mainFailures }] }, main);
}

test('real assertion failures match across fresh native child paths, UUIDs, elapsed times and ephemeral ports [V4,B3,C7]', t => {
  const first = realFailure(t), second = realFailure(t);
  assert.notEqual(first.output, second.output, 'the actual two runs retain distinct volatile diagnostics');
  assert.ok(compare(second.failures, first.failures), 'the same real assertion is a known main failure');
  for (const options of [{ assertion: 'different assertion' }, { expected: 2 }, { name: 'another test [V4]' }, { leaf: 'other-state.json' }]) {
    const changed = realFailure(t, options);
    assert.equal(compare(changed.failures, first.failures), null, JSON.stringify(options) + ' remains a different failure');
  }
});

test('both retained landing-shards diagnostics match noise-only variations without claiming a second measured run [V4,B3,C7]', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/known-main-red/landing-shards.json', import.meta.url), 'utf8'));
  const before = retainedRun(fixture.blocks, fixture.executionRoot);
  assert.equal(before?.length, 2);
  const changedRoot = '/Users/fixture/.pullboard-runner/jobs/11111111-2222-4333-8444-555555555555-AbCdEf/checkout';
  const blocks = fixture.blocks.map(block => block.replaceAll(fixture.executionRoot, changedRoot)
    .replaceAll(fixture.executionRoot.replace(/\/checkout$/u, ''), changedRoot.replace(/\/checkout$/u, ''))
    .replaceAll('pZOEPl', 'aBcDeF').replaceAll('Kw5Une', 'bCdEfG').replaceAll('sr48g6', 'cDeFgH')
    .replace(/elapsed: \d+ms/gu, 'elapsed: 12345ms'));
  const after = retainedRun(blocks, changedRoot);
  assert.deepEqual(after, before, 'both real retained failure identities survive only the recognized runtime noise');
  const semantic = retainedRun(blocks.map(block => block.replaceAll('an unknown GUI runner must not execute this shard', 'a different real assertion')), changedRoot);
  assert.notEqual(semantic[0].signature, before[0].signature);
  assert.equal(semantic[1].signature, before[1].signature);
});

test('cache migration never promotes old raw hashes or coarse red outcomes into normalized proof [V4,B3,C7]', () => {
  const file = 'test/one.test.js', failures = [{ file, name: 'one failure [V4]', signature: 'b'.repeat(64) }];
  assert.equal(cachedFailureSignatures({ result: 'red', failures }, file), undefined);
  assert.equal(cachedFailureSignatures({ result: 'red' }, file), undefined);
  assert.equal(cachedFailureSignatures({ result: 'red', failures, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION - 1 }, file), undefined);
  assert.deepEqual(cachedFailureSignatures({ result: 'red', failures, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION }, file), failures);
  assert.deepEqual(cachedFailureSignatures({ result: 'green', failures: [] }, file), []);
  assert.equal(cachedFailureSignatures({ result: 'red', failures, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION }, 'test/other.test.js'), undefined);
});

test('runtime aliases preserve distinct paths and UUID relationships plus numeric assertion values [V4,B3,C7]', () => {
  const block = (left, right, expected = 2) => `not ok 1 - relational assertion [V4]\n  ---\n  location: '/repo/test/one.test.js:1:1'\n  failureType: 'testCodeFailure'\n  error: 'same assertion'\n  code: 'ERR_ASSERTION'\n  expected: ${expected}\n  actual: 1\n  operator: 'strictEqual'\n  left: '${left}'\n  right: '${right}'\n  ...`;
  const one = '/tmp/pullboard-fixture-AbCdEf/repo/a.json', two = '/tmp/pullboard-fixture-BcDeFg/repo/a.json';
  const identity = text => retainedRun([text], '/repo')[0].signature;
  assert.notEqual(identity(block(one, one)), identity(block(one, two)), 'distinct fixture roots cannot become the same path');
  const id = randomUUID(), other = randomUUID();
  assert.notEqual(identity(block(id, id)), identity(block(id, other)), 'distinct random IDs retain their equality relationship');
  assert.notEqual(identity(block(one, two, 2)), identity(block(one, two, 3)), 'numeric expected values remain semantic');
  assert.notEqual(identity(block(one + ':1', two)), identity(block(one + ':2', two)), 'asserted path-like location values remain semantic outside nested stderr frames');
  assert.notEqual(identity(block('/etc/one', '/etc/two')), identity(block('/etc/one', '/etc/three')), 'non-temporary paths remain literal');
  for (const field of ['expected', 'actual', 'error']) {
    const plain = block(one, two);
    const first = plain.replace(new RegExp('  ' + field + ':.*'), '  ' + field + ': |-\n    at alpha.js:1');
    const second = plain.replace(new RegExp('  ' + field + ':.*'), '  ' + field + ': |-\n    at beta.js:2');
    assert.notEqual(identity(first), identity(second), field + ' source-looking assertion text cannot be discarded as a stack frame');
  }

});

test('normalization never accounts for process failures, missing summaries or cancelled tests [V4,B3,C7]', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/known-main-red/landing-shards.json', import.meta.url), 'utf8'));
  const output = 'TAP version 13\n' + fixture.blocks[0] + '\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n';
  const run = { isGreen: false, executionRoot: fixture.executionRoot, executionRunner: 'retained-unit-fixture', stages: [{ status: 1, output }] };
  assert.equal(failureSignatures(run, fixture.executionRoot)?.length, 1);
  assert.equal(failureSignatures({ ...run, stages: [{ status: 2, output }] }, fixture.executionRoot), null);
  assert.equal(failureSignatures({ ...run, stages: [{ status: 1, output: output.replace('# fail 1', '') }] }, fixture.executionRoot), null);
  assert.equal(failureSignatures({ ...run, stages: [{ status: 1, output: output.replace('# cancelled 0', '# cancelled 1') }] }, fixture.executionRoot), null);
  assert.equal(failureSignatures({ ...run, stages: [{ status: 1, output: output + 'unaccounted subprocess failure\n' }] }, fixture.executionRoot), null);
});
