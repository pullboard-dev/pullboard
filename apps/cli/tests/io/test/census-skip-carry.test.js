/** An opted-in census carries sealed whole-file runner proof, never the last report's summary [C7,#12641]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { testActionKeys } from '../../../../../packages/gate/index.js';
import { testResultStore } from '../../../../../packages/gate/index.js';
import { testResultDigest } from '../../../../../packages/gate/index.js';
import { importTestResults } from '../../../../../packages/gate/index.js';
import { packTestResults } from '../../../../../packages/gate/index.js';
import { retainTestResultCompletion } from '../../../../../packages/gate/index.js';
import { signRunnerReceipt } from '../../../../../packages/runners/index.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runCensus } from '../../../src/io/test/census.js';

const TOOLING = 'a'.repeat(64), RUNTIME = 'b'.repeat(64);
const HOST = 'owner@runner.example.test';
const sealed = name => `packages/sealed/tests/${name}.test.js`;
const OPEN = 'packages/open/tests/unsealed.test.js';

/** A private repo and runner signing key whose receipts enter the production completed-result store. */
function fixture(t, files, enabled = true) {
  const box = privateFixtureFiles('pullboard-census-carry-');
  const repo = join(box.root, 'repo'), home = join(box.root, 'machine-home');
  mkdirSync(repo); mkdirSync(home);
  const clear = new Set(['NODE_OPTIONS', 'TZ', 'LANG', 'LC_ALL', 'PULLBOARD_MACHINE_HOME',
    ...Object.keys(process.env).filter(name => name.startsWith('PULLBOARD_'))]);
  const saved = Object.fromEntries([...clear].map(name => [name, process.env[name]]));
  for (const name of clear) delete process.env[name];
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    for (const name of clear) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(box.root, { recursive: true, force: true });
  });
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const environment = { node: process.versions.node, platform: process.platform, arch: process.arch };
  const settings = on => fixtureMachineSettings(home, { census: { skipUnchanged: on }, runners: [{ host: HOST, slots: 1, browser: 0, publicKey }] });
  settings(enabled);
  box.write('repo/package.json', '{"type":"module","private":true}\n');
  box.write('repo/pullboard.json', JSON.stringify({ lanes: {}, landing: { environment } }));
  box.write('repo/packages/gate/data/tests/test-cells.json', JSON.stringify({ sealed: ['sealed'], journeys: { [sealed('journey')]: 'a journey' } }));
  for (const file of files) {
    const name = file.split('/').at(-1).split('.')[0];
    box.write(`repo/${file}`, `import './${name}.js';\n`);
    box.write(`repo/${file.replace('.test.js', '.js')}`, `export const ${name} = 1;\n`);
  }
  const commit = () => { fixtureCommitAll(repo); return runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo }); };
  const sha = commit();

  /** Sign a runner packet and use the same completion retention and import as the controller. */
  async function record(file, { kind = 'pass', node = process.version, runtime = RUNTIME, authenticated = true } = {}) {
    const tree = runFixtureGit(['rev-parse', `${sha}^{tree}`], { cwd: repo });
    const env = { TZ: 'UTC', LANG: 'C', PULLBOARD_TEST_CACHE_TOOLING: TOOLING };
    const { inputKey, context } = (await testActionKeys(repo, { commit: sha, env, files: [file], maintain: false })).get(file);
    const at = new Date().toISOString(), id = randomUUID();
    const ctx = { ...context, node };
    const row = { version: 2, key: testResultDigest({ inputKey, context: ctx }), inputKey, context: ctx, file,
      status: kind === 'red' ? 'fail' : 'pass', commit: sha, stage: 'census', at,
      origin: { machine: HOST, stage: 'census', commit: sha, at, request: id, fileExit: kind === 'red' ? 1 : 0 } };
    if (kind !== 'red') row.tap = { lines: ['ok 1 - full case'], counts: { passed: 1, failed: 0, skipped: 0, tests: 1 }, observedTests: 1,
      ...(kind === 'partial' ? {} : { testOutcomes: [{ file, name: 'full case', passed: true, skipped: false }] }) };
    const body = { id, commit: sha, tree, code: kind === 'red' ? 1 : 0, signal: null, outputSha256: 'c'.repeat(64),
      runtimeSha256: runtime, toolingSha256: TOOLING, environment, testResults: packTestResults([row]) };
    const signed = { ...body, signature: signRunnerReceipt(body, key.privateKey) };
    if (!authenticated) signed.signature = 'invalid';
    const store = testResultStore(repo);
    const completion = retainTestResultCompletion(store, signed);
    assert.equal(importTestResults(store, body.testResults, [inputKey], completion), 1);
    return { id, key: row.key };
  }
  return { repo, box, sha, commit, record, settings };
}

/** Drive the real census output while supplying a deterministic fresh-file dispatcher. */
async function census(fx, label, prefixes = []) {
  const calls = [], summaries = [];
  const out = join(fx.repo, '.git', 'pullboard', 'census', `${label}.jsonl`);
  const run = async ({ files, write }) => {
    calls.push(...files);
    write('# landing shard 1/1 attempt 1 on host: green in 900 ms\n');
    write(`${files.flatMap(file => [`# landing-file-ms 100 ${file}`, `# landing-file-exit 0 ${file}`]).join('\n')}\n# tests ${files.length}\n# pass ${files.length}\n`);
    write('# landing result: done\n');
    return { isGreen: true };
  };
  const status = await runCensus({ say: line => summaries.push(line), err() {} }, { info: { root: fx.repo } }, { out },
    { prefixes, shards: 1, run, trustedTooling: () => ({ tooling: { sha256: TOOLING }, runtime: { sha256: RUNTIME } }) });
  assert.equal(status, 0);
  const rows = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line)).map(row => [row.file, row]));
  return { calls, rows, summaries };
}

test('cli.io-test-census-skip-carry.with-census-skipunchanged-on-a-census-on: clause 1: a sealed file carries its signed full result on the same or unchanged new commit after a partial census [C7,#12641]', async t => {
  const [a, b, c] = ['a', 'b', 'c'].map(sealed);
  const fx = fixture(t, [a, b, c]);
  assert.deepEqual((await census(fx, 'partial', [a])).calls, [a]);
  const proof = await fx.record(a);
  await fx.record(b);
  const same = await census(fx, 'same');
  assert.deepEqual(same.calls, [c]);
  assert.deepEqual(same.rows[a], { file: a, sha: fx.sha, status: 'green', carried: true, carriedFrom: fx.sha, proof: { key: proof.key, receipt: proof.id } });
  assert.match(same.summaries[0], /2 carried proofs, 1 fresh/u);
  fx.box.write('repo/packages/sealed/tests/a.js', 'export const a = 2;\n');
  const second = fx.commit();
  const next = await census(fx, 'changed');
  assert.deepEqual(next.calls.toSorted(), [a, c]);
  assert.equal(next.rows[b].carriedFrom, fx.sha);
  assert.equal(next.rows[b].sha, second);
  assert.equal(next.rows[a].carried, undefined);
});

test('cli.io-test-census-skip-carry.with-the-setting-off-or-a-census: clause 2: red, incomplete, unsigned, mismatched runtime and unsealed files all run fresh [C7,#12641]', async t => {
  const [good, red, partial, unsigned, node, runtime, absent, journey] = ['good','red','partial','unsigned','node','runtime','absent','journey'].map(sealed);
  const files = [good, red, partial, unsigned, node, runtime, absent, journey, OPEN];
  const fx = fixture(t, files);
  await fx.record(good);
  await fx.record(red);
  await fx.record(red, { kind: 'red' });
  await fx.record(partial, { kind: 'partial' });
  await fx.record(unsigned, { authenticated: false });
  await fx.record(node, { node: 'v22.0.0' });
  await fx.record(runtime, { runtime: 'd'.repeat(64) });
  await fx.record(journey);
  await fx.record(OPEN);
  const optedIn = await census(fx, 'opted-in');
  assert.deepEqual(optedIn.calls.toSorted(), files.filter(file => file !== good).toSorted());
  assert.deepEqual(Object.values(optedIn.rows).filter(row => row.carried).map(row => row.file), [good]);
  fx.settings(false);
  const off = await census(fx, 'off');
  assert.deepEqual(off.calls.toSorted(), files.toSorted());
  assert.ok(Object.values(off.rows).every(row => !row.carried));
});
