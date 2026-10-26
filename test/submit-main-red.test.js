/** Inherited failures can pass submit without disguising new failures as known [V4,B3]. */
import '../src/cli.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_SHELL_MARKERS } from '../src/person.js';
import { runFixtureChild } from './fixture-child.js';
import { runFixtureGit } from './fixture-child.js';
import { submissionProof } from '../src/submit-invariants.js';
import { KNOWN_MAIN_FAILURES_ENGINE } from '../src/known-main-failures-engine.js';
import { matchingMainFailures } from '../src/main-failure-matches.js';
import { failureSignatures } from '../src/main-failure-matches.js';

const BIN = join(import.meta.dirname, '../bin/pullboard.js');

/** Write one ordinary committed fixture input. */
function put(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

/** Run the actual command with isolated identity and machine settings. */
function cli(box, root, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args, '--json'], { cwd: root, env: box.env, encoding: 'utf8' });
}

/** Commit fixture changes normally, retaining its real Git history. */
function commit(box, root) {
  runFixtureGit(['add', '-A'], { cwd: root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'test(core): inherited failure fixture [G1]'], { cwd: root, env: box.env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env: box.env }).trim();
}

/** Produce a real assertion failure whose name and error details are independently variable. */
function source(name = 'shared failure [G1]', expected = 2) {
  return `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest(${JSON.stringify(name)}, () => assert.equal(1, ${expected}));\n`;
}

/** Build and claim one private board whose accepted main already has a named red test. */
function fixture(t, { candidate = source(), check = 'test -f change.txt', gateSuffix = '' } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-submit-main-red-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || AGENT_SHELL_MARKERS.includes(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_RELAY_TOKEN;
  Object.assign(env, {
    PATH: [join(directory, 'bin'), process.env.PATH].filter(Boolean).join(delimiter),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Main red fixture', GIT_AUTHOR_EMAIL: 'main-red@example.invalid',
    GIT_COMMITTER_NAME: 'Main red fixture', GIT_COMMITTER_EMAIL: 'main-red@example.invalid',
    PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    CODEX_SESSION_ID: 'submit-main-red-fixture', PULLBOARD_MODEL: 'Fixture Model',
  });
  const box = { directory, root, env };
  const word = value => "'" + value.replaceAll("'", "'\\''") + "'";
  put(directory, 'bin/pullboard', `#!/bin/sh\nexec ${word(process.execPath)} ${word(BIN)} "$@"\n`);
  chmodSync(join(directory, 'bin/pullboard'), 0o755);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  let result = cli(box, root, 'init');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'pullboard.json', JSON.stringify({ gate: 'node test/runner.js' + gateSuffix,
    affectedTests: 'node test/runner.js', lanes: { core: { owns: ['test/', 'change.txt'], specs: ['G'] } } }));
  put(root, 'SPEC.md', '# Fixture\n\n## G · Goals\n- G1 [approved, must] The unrelated change works. | gate: test/inherited.test.js\n');
  put(root, 'test/inherited.test.js', source());
  put(root, 'test/runner.js', [
    "import { spawnSync } from 'node:child_process';",
    "const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test/inherited.test.js'];",
    "const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', env: process.env });",
    "process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    'process.exitCode = run.status ?? 1;',
  ].join('\n') + '\n');
  box.main = commit(box, root);
  result = cli(box, root, 'add', 'core', 'Unrelated change', '--specs', 'G1', '--route', 'mid',
    '--criterion', 'The unrelated change works.', '--check', check, '--brief', 'Files: change.txt, test/\nTest: inherited failure accounting');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  box.item = JSON.parse(result.stdout).item.item_id;
  result = cli(box, root, 'worktree', 'core', '--route', 'mid', '--model', 'Fixture Model');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  box.builder = JSON.parse(result.stdout).path;
  result = cli(box, box.builder, 'claim', String(box.item));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  put(box.builder, 'change.txt', 'Unrelated change.\n');
  put(box.builder, 'test/inherited.test.js', candidate);
  box.head = commit(box, box.builder);
  return box;
}

/** Read the canonical submitted receipt rather than trusting a successful shell exit alone. */
function submittedProof(box) {
  const db = new DatabaseSync(join(box.root, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    const row = db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(box.item);
    return row ? JSON.parse(row.event_detail) : null;
  } finally { db.close(); }
}

test('submit accepts a test that fails the same way on main and refuses one red only with the item [V4,B3]', t => {
  const known = fixture(t);
  const cache = join(known.root, '.git/pullboard/main-red.json');
  writeFileSync(cache, JSON.stringify({ version: 1, entries: { [known.main]: { 'test/inherited.test.js': { result: 'red' } } } }), { mode: 0o600 });
  const result = cli(known, known.builder, 'submit', String(known.item));
  const proofLog = runFixtureGit(['rev-parse', '--git-path', 'pullboard-submit.log.proof.log'], { cwd: known.builder, env: known.env }).trim();
  const observed = result.status ? { cache: JSON.parse(readFileSync(cache, 'utf8')),
    parsed: failureSignatures({ isGreen: false, stages: [{ status: 1, output: readFileSync(proofLog, 'utf8') }] }, known.builder) } : null;
  assert.equal(result.status, 0, JSON.stringify({ response: result.stdout + result.stderr, observed }));
  const report = JSON.parse(result.stdout);
  assert.equal(report.gate.green, false, 'an inherited failure stays red in its receipt');
  assert.equal(report.gate.knownMainFailures.main, known.main);
  assert.deepEqual(report.gate.knownMainFailures.failures.map(({ file, name }) => ({ file, name })),
    [{ file: 'test/inherited.test.js', name: 'shared failure [G1]' }]);
  assert.deepEqual(submittedProof(known).submissionProof.knownMainFailures, report.gate.knownMainFailures);
  const changed = fixture(t, { candidate: source('shared failure [G1]') + source('new item failure [G1]').split('\n').slice(2).join('\n') });
  const refused = cli(changed, changed.builder, 'submit', String(changed.item));
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'GATE_RED');
  assert.equal(submittedProof(changed), null, 'a new failure in an already-red file still prevents submit');
});

test('known main receipts preserve exact identities and refuse unsupported historical envelopes [V4,B3,H16]', () => {
  const failure = { file: 'test/one.test.js', name: 'one failure [V4]', signature: 'a'.repeat(64) };
  const main = 'b'.repeat(40);
  const proof = { version: 1, files: [failure.file], full: false, deferred: false, reason: '',
    knownMainFailures: { main, failures: [failure] } };
  assert.deepEqual(submissionProof(proof, KNOWN_MAIN_FAILURES_ENGINE).knownMainFailures, proof.knownMainFailures);
  assert.throws(() => submissionProof(proof, KNOWN_MAIN_FAILURES_ENGINE - 1), { code: 'SUBMISSION_PROOF' });
  const historical = { version: 1, files: [], full: true, deferred: false, reason: 'historical full gate' };
  assert.deepEqual(submissionProof(historical, KNOWN_MAIN_FAILURES_ENGINE - 1), historical);
  for (const bad of [{ main, failures: [] }, { main: 'unknown', failures: [failure] },
    { main, failures: [{ ...failure, file: '../outside.test.js' }] }, { main, failures: [{ ...failure, signature: null }] }]) {
    assert.throws(() => submissionProof({ ...proof, knownMainFailures: bad }), { code: 'SUBMISSION_PROOF' });
  }
  const compared = { main, files: [{ file: failure.file, result: 'red', failures: [failure] }] };
  assert.deepEqual(matchingMainFailures([failure], compared, main), proof.knownMainFailures);
  assert.equal(matchingMainFailures([failure], compared, 'c'.repeat(40)), null);
  assert.equal(matchingMainFailures([failure], { ...compared, unavailable: 'timeout' }, main), null);
  assert.equal(matchingMainFailures([failure], { main, files: [{ file: failure.file, result: 'red' }] }, main), null);
  assert.equal(matchingMainFailures([{ ...failure, name: 'different failure' }], compared, main), null);
  assert.equal(matchingMainFailures([{ ...failure, file: 'test/other.test.js' }], compared, main), null);
  assert.equal(matchingMainFailures([{ ...failure, signature: 'd'.repeat(64) }], compared, main), null);
  assert.equal(matchingMainFailures([failure], { main, files: [{ file: failure.file, result: 'red', failures: [failure, failure] }] }, main), null);
});

test('submit refuses changed failure details, an unaccounted stage, and a red frozen check [V4,B3]', t => {
  for (const options of [
    { candidate: source('shared failure [G1]', 3) },
    { gateSuffix: '; exit 7' },
    { check: 'node test/runner.js' },
  ]) {
    const box = fixture(t, options);
    const result = cli(box, box.builder, 'submit', String(box.item));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
    assert.equal(submittedProof(box), null);
  }
});
