/** Inherited failures can pass submit without disguising new failures as known [V4,B3]. */
import '../../../index.js'; // This test invokes the real CLI through its public executable.
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
import { companionMainFailuresUntouched } from '../../../../../packages/landing/index.js';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import { submissionProof } from '../../../../../packages/state/light.js';
import { KNOWN_MAIN_FAILURES_ENGINE } from '../../../../../packages/state/light.js';
import { matchingMainFailures } from '../../../../../packages/landing/index.js';
import { failureSignatures } from '../../../../../packages/landing/index.js';

const BIN = join(import.meta.dirname, '../../../pullboard.js');

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
  return `import assert from 'node:assert/strict';\nimport { test } from 'node:test';
import { companionMainFailuresUntouched } from '../src/main-red.js';\ntest(${JSON.stringify(name)}, () => assert.equal(1, ${expected}));\n`;
}

/** Build and claim one private board whose accepted main already has a named red test. */
function fixture(t, { candidate = source(), check = 'test -f change.txt', gateSuffix = '', mainRed = true } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-known-main-companion-')));
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
    affectedTests: 'node test/runner.js', lanes: { core: { owns: ['test/', 'change.txt', 'docs/', 'src/'], specs: ['G'] } } }));
  put(root, 'SPEC.md', '# Fixture\n\n## G · Goals\n- G1 [approved, must] The unrelated change works. | gate: test/inherited.test.js\n');
  put(root, 'test/inherited.test.js', source());
  put(root, 'docs/companion.md', 'Before.\n');
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
  if (mainRed) box.rework = fileMainRed(box);
  return box;
}

/** File a still-open repair with the exact failing test in its declared check. */
function fileMainRed(box) {
  const result = cli(box, box.root, 'add', 'core', 'Main red: inherited assertion needs repair', '--specs', 'G1',
    '--criterion', 'The inherited assertion passes on main.', '--check', 'node test/runner.js test/inherited.test.js',
    '--brief', 'Files: test/inherited.test.js\nTest: inherited assertion');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

/** Read the canonical submitted receipt rather than trusting a successful shell exit alone. */
function submittedProof(box) {
  const db = new DatabaseSync(join(box.root, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    const row = db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(box.item);
    return row ? JSON.parse(row.event_detail) : null;
  } finally { db.close(); }
}

/** Attach a real committed-source companion through the authenticated coordinator. */
function attachCompanion(box, file, source, before, after) {
  const agent = JSON.parse(cli(box, box.builder, 'whoami').stdout).id;
  const lines = source.replace(/\n$/u, '').split('\n');
  assert.equal(lines[0], before, 'the patch binds the actual first-line preimage');
  const replacement = [after, ...lines.slice(1)];
  const patch = ['diff --git a/' + file + ' b/' + file, '--- a/' + file, '+++ b/' + file,
    `@@ -1,${lines.length} +1,${replacement.length} @@`,
    ...lines.map(line => '-' + line), ...replacement.map(line => '+' + line), ''].join('\n');
  const path = join(box.directory, 'companion.patch');
  writeFileSync(path, patch);
  const result = cli(box, box.root, 'patch', 'attach', String(box.item), path,
    '--key', 'known-main-companion', '--author', agent, '--source', box.head);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('an untouched inherited failure passes with a real docs companion [V4,B3]', t => {
  const box = fixture(t);
  attachCompanion(box, 'docs/companion.md', readFileSync(join(box.builder, 'docs/companion.md'), 'utf8'), 'Before.', 'After.');
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.gate.green, false);
  assert.equal(report.gate.knownMainFailures.main, box.main);
  assert.deepEqual(report.gate.knownMainFailures.failures.map(row => row.file), ['test/inherited.test.js']);
  assert.ok(submittedProof(box), 'actual native submit event was recorded');
});

test('a companion frozen-check red retains its required refusal [V4,B3]', t => {
  const box = fixture(t, { check: 'node test/runner.js test/inherited.test.js' });
  attachCompanion(box, 'docs/companion.md', readFileSync(join(box.builder, 'docs/companion.md'), 'utf8'), 'Before.', 'After.');
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.error.code, 'GATE_RED');
  assert.match(response.error.message, /item check red/u, 'the actual composed frozen check ran and remains mandatory');
  assert.equal(submittedProof(box), null, 'a known-main summary cannot bypass the green criterion seal');
});

test('editing a failed test in a companion never inherits its main failure [V4,B3]', t => {
  const box = fixture(t);
  attachCompanion(box, 'test/inherited.test.js', readFileSync(join(box.builder, 'test/inherited.test.js'), 'utf8'), "import assert from 'node:assert/strict';", "import assert from 'node:assert/strict'; // Companion edit.");
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED', result.stdout + result.stderr);
  assert.equal(submittedProof(box), null);
});

test('companion input proof refuses imported helper changes and unknown closures [V4,B3]', t => {
  const box = fixture(t);
  put(box.builder, 'test/helper.js', 'export const answer = 2;\n');
  put(box.builder, 'test/inherited.test.js', "import {answer} from './helper.js';\n" + source().replace('assert.equal(1, 2)', 'assert.equal(1, answer)'));
  const sourceHead = commit(box, box.builder);
  put(box.builder, 'test/helper.js', 'export const answer = 2; // Changed bytes.\n');
  const composed = commit(box, box.builder);
  const failures = [{ file: 'test/inherited.test.js' }];
  assert.equal(companionMainFailuresUntouched(box.builder, { base: sourceHead, source: sourceHead, composed }, failures), false);
  put(box.builder, 'test/inherited.test.js', "await import(process.env.UNKNOWN_IMPORT);\n" + source());
  const unknown = commit(box, box.builder);
  assert.equal(companionMainFailuresUntouched(box.builder, { base: unknown, source: unknown, composed: unknown }, failures), false);
});

test('companion source-tree and documentation data changes cannot inherit a reader failure [V4,B3]', t => {
  const box = fixture(t);
  put(box.builder, 'src/scanned.js', 'export const value = 1;\n');
  put(box.builder, 'test/scanner.test.js', "/** @pullboard-test-input source-tree */\nimport {readFileSync} from 'node:fs';\nimport {test} from 'node:test';\ntest('source scanner',()=>readFileSync(new URL('../src/scanned.js',import.meta.url),'utf8'));\n");
  put(box.builder, 'test/docs-reader.test.js', "import {readFileSync} from 'node:fs';\nimport {test} from 'node:test';\ntest('doc reader',()=>readFileSync(new URL('../docs/companion.md',import.meta.url),'utf8'));\n");
  const base = commit(box, box.builder);
  put(box.builder, 'src/scanned.js', 'export const value = 2;\n');
  const sourceChange = commit(box, box.builder);
  assert.equal(companionMainFailuresUntouched(box.builder, { base, source: base, composed: sourceChange }, [{file:'test/scanner.test.js'}]), false);
  put(box.builder, 'docs/companion.md', 'Changed data.\n');
  const docsChange = commit(box, box.builder);
  assert.equal(companionMainFailuresUntouched(box.builder, { base, source: sourceChange, composed: docsChange }, [{file:'test/docs-reader.test.js'}]), false);
});
