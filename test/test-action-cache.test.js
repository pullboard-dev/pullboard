/** @pullboard-test-input source-tree */
/** A test file whose inputs did not change reuses its green result; a changed import, a red result or a bad entry runs it [C7]. */
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { suiteProven } from '../src/test-action-cache.js';
import { testActionKeys } from '../src/test-action-cache.js';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));
const source = fileURLToPath(new URL('../src', import.meta.url));

/** A fixture test that records its own name, then passes when its module says so. */
function fixtureTest(name, module) {
  return `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
import { value } from '../lib/${module}.js';
/** Record that this file ran, then check its module. */
function check() { appendFileSync(process.env.PULLBOARD_ACTION_CAPTURE, '${name}\\n'); if (value !== 'green') throw new Error('${name} is red'); }
test('${name} [C7]', check);
`;
}

/** A fixture test that declares the source tree and scans one source file as data, which no test imports. */
const SCAN_TEST = `/** @pullboard-test-input source-tree */
import { appendFileSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
/** Record that this file ran, then scan the probe's text. */
function scan() { appendFileSync(process.env.PULLBOARD_ACTION_CAPTURE, 'd\\n'); if (readFileSync(new URL('../src/probe.js', import.meta.url), 'utf8').includes('forbidden')) throw new Error('d found a forbidden word'); }
test('d [C7]', scan);
`;

/** A fixture test that lists this checkout's tracked release notes without declaring them, then scans them. */
const NOTES_TEST = `import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
const root = join(import.meta.dirname, '..');
/** Record that this file ran, then scan every listed note. */
function scanNotes() { appendFileSync(process.env.PULLBOARD_ACTION_CAPTURE, 'e\\n'); const tracked = execFileSync('git', ['ls-files', 'CHANGELOG.md'], { cwd: root, encoding: 'utf8' }).trim().split('\\n'); for (const name of tracked) if (readFileSync(join(root, name), 'utf8').includes('forbidden')) throw new Error('e found a forbidden word'); }
test('e [C7]', scanNotes);
`;

/** A committed repository with the real runner, three tests and their modules: A imports shared, B and C stand alone. */
function makeFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-test-actions-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ['bin', 'lib', 'test']) mkdirSync(join(root, folder));
  copyFileSync(runner, join(root, 'bin', 'run-tests.js'));
  cpSync(source, join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'bin/\nsrc/\nmachine/\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, 'lib', 'shared.js'), "export const shared = 'green';\n");
  writeFileSync(join(root, 'lib', 'a.js'), "import { shared } from './shared.js';\nexport const value = shared;\n");
  writeFileSync(join(root, 'lib', 'b.js'), "export const value = 'green';\n");
  writeFileSync(join(root, 'lib', 'c.js'), "export const value = 'red';\n");
  for (const name of ['a', 'b', 'c']) writeFileSync(join(root, 'test', `${name}.test.js`), fixtureTest(name, name));
  writeFileSync(join(root, 'test', 'd.test.js'), SCAN_TEST);
  writeFileSync(join(root, 'test', 'e.test.js'), NOTES_TEST);
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n');
  writeFileSync(join(root, 'src', 'probe.js'), "// A probe source file.\nexport const probe = 1;\n");
  const capture = join(root, 'machine', 'ran.txt');
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_ACTION_CAPTURE: capture, PULLBOARD_LANDING_RUN: '0',
    GIT_AUTHOR_NAME: 'Action Fixture', GIT_AUTHOR_EMAIL: 'action@example.test', GIT_COMMITTER_NAME: 'Action Fixture', GIT_COMMITTER_EMAIL: 'action@example.test' };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_TEST_STAGE', 'PULLBOARD_TEST_ACTIONS', 'PULLBOARD_TEST_REUSE', 'PULLBOARD_TEST_RESULT_STORE', 'PULLBOARD_TEST_RESULT_ORIGIN', 'PULLBOARD_TEST_CACHE_TOOLING']) delete env[key];
  mkdirSync(join(root, 'machine'));
  /** Run one fixture git command under the private environment. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  git('add', '.gitignore', 'package.json', 'CHANGELOG.md', 'lib', 'test');
  git('add', '-f', 'src/probe.js');
  git('commit', '-q', '-m', 'fixture');
  /** Commit one file's new text. */
  const change = (path, text) => { writeFileSync(join(root, path), text); git('add', '-f', '--', path); git('commit', '-q', '-m', `change ${path}`, '--', path); };
  /** Run the whole suite through the real runner; return its status, output and the files that ran. */
  const run = (files = []) => {
    writeFileSync(capture, '');
    const result = runFixtureChild(process.execPath, ['bin/run-tests.js', ...files], { cwd: root, env, encoding: 'utf8', timeout: 25_000 });
    const ran = readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).sort();
    return { status: result.status, output: `${result.stdout}\n${result.stderr}`, ran, context: result.context };
  };
  const store = join(root, '.git', 'pullboard', 'test-actions');
  return { root, change, run, store, env };
}

test('an unchanged closure reuses its green result and a changed import reruns it [C7]', (t) => {
  const fixture = makeFixture(t);
  const first = fixture.run();
  assert.equal(first.status, 1, `C is red, so the first run fails\n${first.output}`);
  assert.deepEqual(first.ran, ['a', 'b', 'c', 'd', 'e'], 'every file runs when nothing is stored');

  // 1. A module only B imports changes: B runs, A is reused, C runs because a red result is never reused (3). E lists
  // this checkout's tracked files without declaring them, so it has no key and runs every time (fail closed).
  fixture.change('lib/b.js', "export const value = 'green'; // edited\n");
  const second = fixture.run();
  assert.deepEqual(second.ran, ['b', 'c', 'e'], second.output);
  assert.match(second.output, /^# reused [0-9a-f]{64} from \S+ [0-9a-f]{40} \(test\/a\.test\.js\)$/mu);
  assert.doesNotMatch(second.output, /reused .*\(test\/(?:b|c)\.test\.js\)/u);

  // 2. A module A imports changes: A runs and B is reused; C still runs.
  fixture.change('lib/shared.js', "export const shared = 'green'; // edited\n");
  const third = fixture.run();
  assert.deepEqual(third.ran, ['a', 'c', 'e'], third.output);
  assert.match(third.output, /^# reused [0-9a-f]{64} from \S+ [0-9a-f]{40} \(test\/b\.test\.js\)$/mu);
  assert.equal(readdirSync(join(fixture.store, 'red')).length, 1, 'C has one red key, written once and kept');

  // 4. A missing entry (A) and a corrupt entry (B) both run their file; C turns green under a new key and runs.
  const entries = readdirSync(join(fixture.store, 'green'))
    .map(name => [name, JSON.parse(readFileSync(join(fixture.store, 'green', name), 'utf8')).file]);
  assert.deepEqual([...new Set(entries.map(([, file]) => file))].sort(), ['test/a.test.js', 'test/b.test.js', 'test/d.test.js'], 'only green files are stored');
  for (const [name, file] of entries) {
    if (file === 'test/a.test.js') rmSync(join(fixture.store, 'green', name));
    else if (file === 'test/b.test.js') writeFileSync(join(fixture.store, 'green', name), '{"version":1,"key":');
  }
  fixture.change('lib/c.js', "export const value = 'green';\n");
  const fourth = fixture.run();
  assert.equal(fourth.status, 0, fourth.output);
  assert.deepEqual(fourth.ran, ['a', 'b', 'c', 'e'], fourth.output);
  assert.match(fourth.output, /^# reused [0-9a-f]{64} from \S+ [0-9a-f]{40} \(test\/d\.test\.js\)$/mu, 'D reads only the source tree, which no change touched');

  // Nothing changed since a green run: only the unkeyed lister runs; every keyed file is reused.
  const fifth = fixture.run();
  assert.equal(fifth.status, 0, fifth.output);
  assert.deepEqual(fifth.ran, ['e'], fifth.output);
  assert.equal(fifth.output.match(/^# reused /gmu)?.length, 4, fifth.output);

  // Cached versus fresh: a forbidden word reaches only CHANGELOG.md. E lists and reads it, so E runs and turns red.
  fixture.change('CHANGELOG.md', '# Changelog\n\nA forbidden word.\n');
  const notes = fixture.run();
  assert.deepEqual(notes.ran, ['e'], notes.output);
  assert.equal(notes.status, 1, notes.output);
  assert.match(notes.output, /e found a forbidden word/u);

  // Cached versus fresh: only a comment changes, in a source file nothing imports. D reads it as data, so D runs and
  // its fresh verdict differs from the green it would otherwise have reused.
  fixture.change('src/probe.js', "// A probe source file with a forbidden word.\nexport const probe = 1;\n");
  const sixth = fixture.run();
  assert.deepEqual(sixth.ran, ['d', 'e'], sixth.output);
  assert.equal(sixth.status, 1, sixth.output);
  assert.match(sixth.output, /d found a forbidden word/u, 'the fresh scan finds the word the stored green never saw');
});

test('a reused result prints the same TAP as a fresh run [C7]', (t) => {
  const fixture = makeFixture(t);
  fixture.change('test/b.test.js', `${fixtureTest('b', 'b')}
test('skipped # proof', { skip: 'not selected by the fixture' }, () => {});
test('nested proof', async t => { await t.test('child proof', () => {}); });
`);
  const first = fixture.run(['test/b.test.js']);
  assert.equal(first.status, 0, first.output);
  assert.deepEqual(first.ran, ['b']);
  const second = fixture.run(['test/b.test.js']);
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(second.ran, [], 'the receipt is replayed, not another execution');
  assert.match(second.output, /^# reused [0-9a-f]{64} from focused [0-9a-f]{40} \(test\/b\.test\.js\)$/mu);
  /** Extract only the exact proof lines the criterion promises to retain. */
  const proof = output => output.split('\n').filter(line => /^\s*ok \d+(?: |$)|^# (?:pass|fail|skipped) \d+$/u.test(line));
  assert.deepEqual(proof(second.output), proof(first.output));
  assert.match(second.output, /^# pass 3$/mu);
  assert.match(second.output, /^# fail 0$/mu);
  assert.match(second.output, /^# skipped 1$/mu);
  const entries = readdirSync(join(fixture.store, 'green'));
  assert.equal(entries.length, 1);
  const path = join(fixture.store, 'green', entries[0]);
  const legacy = JSON.parse(readFileSync(path, 'utf8'));
  delete legacy.tap;
  writeFileSync(path, JSON.stringify(legacy));
  const oldEntry = fixture.run(['test/b.test.js']);
  assert.equal(oldEntry.status, 0, oldEntry.output);
  assert.deepEqual(oldEntry.ran, ['b'], 'a pre-upgrade status-only entry has no replayable proof and runs fresh');
});

test('a test that reads its own checkout history is never keyed [C7]', async (t) => {
  const fixture = makeFixture(t);
  writeFileSync(join(fixture.root, 'test', 'h.test.js'), `/** @pullboard-test-input source-tree */
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
/** Read this checkout's commit subjects. */
function history() { execFileSync('git', ['log', '--format=%s'], { cwd: new URL('..', import.meta.url) }); }
test('h [C7]', history);
`);
  fixture.change('test/h.test.js', readFileSync(join(fixture.root, 'test', 'h.test.js'), 'utf8'));
  const keys = await testActionKeys(fixture.root);
  assert.equal(keys.get('test/h.test.js').key, null, 'commits are not in any tree a key hashes');
  assert.match(keys.get('test/h.test.js').reason, /git history/u);
  assert.match(keys.get('test/d.test.js').key, /^[0-9a-f]{64}$/u, 'a scanner without history keeps its key');
  assert.equal(keys.get('test/e.test.js').key, null, 'an undeclared listing of this checkout has no key');
});

test('only passing results under the current key prove the whole suite [C7]', () => {
  const files = ['test/a.test.js', 'test/b.test.js'];
  const fresh = { status: 'pass', source: 'fresh' };
  const reused = { status: 'pass', source: 'reused', key: 'k1', currentKey: 'k1' };
  assert.equal(suiteProven(files, new Map([[files[0], fresh], [files[1], reused]])).proven, true);
  assert.deepEqual(suiteProven(files, new Map([[files[0], fresh]])).missing, [files[1]]);
  assert.deepEqual(suiteProven(files, new Map([[files[0], fresh], [files[1], { ...fresh, status: 'fail' }]])).failed, [files[1]]);
  assert.deepEqual(suiteProven(files, new Map([[files[0], fresh], [files[1], { ...reused, currentKey: 'k2' }]])).stale, [files[1]]);
  assert.equal(suiteProven([], new Map()).proven, false, 'an empty suite proves nothing');
});

test('filtered results reuse only the same selection and still invalidate reached inputs [C7]', t => {
  const fixture = makeFixture(t);
  fixture.change('test/b.test.js', `${fixtureTest('b', 'b')}
test('other [C7]', () => appendFileSync(process.env.PULLBOARD_ACTION_CAPTURE, 'other\\n'));
`);
  const selected = ['--test-name-pattern', '^b ', 'test/b.test.js'];
  const first = fixture.run(selected);
  assert.equal(first.status, 0, first.output);
  assert.deepEqual(first.ran, ['b']);
  const second = fixture.run(selected);
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(second.ran, [], 'the identical filtered proof is reused without executing its body');
  assert.match(second.output, /^# reused /mu);
  const whole = fixture.run(['test/b.test.js']);
  assert.equal(whole.status, 0, whole.output);
  assert.deepEqual(whole.ran, ['b', 'other'], 'a filtered proof never stands in for the whole file');
  fixture.change('lib/b.js', "export const value = 'green'; // reached input changed\n");
  const changed = fixture.run(selected);
  assert.equal(changed.status, 0, changed.output);
  assert.deepEqual(changed.ran, ['b'], 'a reached-module edit invalidates the matching filtered proof');
});

test('an unchanged selected proof crosses stages without reading the repository graph again [C7]', t => {
  const fixture = makeFixture(t);
  fixture.env.PULLBOARD_TEST_STAGE = 'submit';
  const first = fixture.run(['test/b.test.js']);
  assert.equal(first.status, 0, first.output);
  assert.deepEqual(first.ran, ['b']);
  const git = fixture.env.PATH.split(delimiter).map(folder => join(folder, 'git')).find(existsSync);
  assert.ok(git, 'the fixture uses the real installed Git');
  const bin = join(fixture.root, 'machine', 'bin');
  mkdirSync(bin);
  // Reject graph construction at its actual Git boundary, rather than timing it or mocking a key.
  writeFileSync(join(bin, 'git'), `#!/bin/sh
for arg do
  case "$arg" in ls-tree|cat-file|show) echo 'unexpected repository graph read' >&2; exit 97;; esac
done
exec '${realpathSync(git).replaceAll("'", "'\\''")}' "$@"
`);
  chmodSync(join(bin, 'git'), 0o700);
  fixture.env.PATH = `${bin}${delimiter}${fixture.env.PATH}`;
  fixture.env.PULLBOARD_TEST_STAGE = 'verify';
  const second = fixture.run(['test/b.test.js']);
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(second.ran, [], 'the unchanged proof is found without a graph scan or another worker body');
  assert.match(second.output, /^# reused [0-9a-f]{64} from submit /mu, 'the original stage remains its provenance');
});
