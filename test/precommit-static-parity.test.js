/** The pre-commit hook runs the gate's changed-file static checks on staged files, so a static red never costs a gate run [C7]. */
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { spawnSync } from 'node:child_process';

const helpers = createE2eHelpers();
after(() => helpers.cleanup());

const REAL = join(import.meta.dirname, '..', 'bin', 'checks');

/** A project whose static checks name the repository checker; its shared list is the real module, so hook and gate cannot drift. */
function staticProject() {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  mkdirSync(join(box.repo, 'bin', 'checks'), { recursive: true });
  copyFileSync(join(REAL, 'test-waits-baseline.json'), join(box.repo, 'bin', 'checks', 'test-waits-baseline.json'));
  writeFileSync(join(box.repo, 'bin', 'checks', 'changed-static.js'), [
    `import { changedStaticFailures } from ${JSON.stringify(pathToFileURL(join(REAL, 'changed-static.js')).href)};`,
    "const failures = changedStaticFailures(process.cwd(), process.argv.slice(3), { staged: process.argv[2] === '--staged' });",
    "if (failures.length) { process.stderr.write(failures.join('\\n') + '\\n'); process.exitCode = 1; }", ''].join('\n'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...JSON.parse(box.git(box.repo, 'show', 'HEAD:pullboard.json')), gate: 'true',
    staticChecks: 'node bin/static-style-checks.js' }, null, 2));
  return box;
}

/** Stage one source file and try to commit it with the plain hook-run command. */
function commitSource(box, file, source) {
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, file), source);
  box.git(box.repo, 'add', file);
  return box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: add a source file');
}

test('the shared changed-file list passes a clean file [C7]', () => {
  const dir = join(import.meta.dirname, '..');
  const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', join(REAL, 'changed-static.js'), 'bin/checks/changed-static.js'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('the hook refuses a commit with two import bindings on one line, using the gate message [C7]', () => {
  const box = staticProject();
  const started = performance.now();
  const refused = commitSource(box, 'src/two.js', "import { readFileSync, existsSync } from 'node:fs';\nexport const a = [readFileSync, existsSync];\n");
  assert.ok(performance.now() - started < 1000, 'static refusal finishes under one second');
  assert.notEqual(refused.status ?? refused.code, 0, 'the commit is refused');
  assert.match(`${refused.stderr ?? refused.err}${refused.stdout ?? refused.out ?? ''}`, /src\/two\.js:1: one import binding per line \(2 bindings\)/u);
});

test('the hook lets a clean staged file commit [C7]', () => {
  const box = staticProject();
  const done = commitSource(box, 'src/one.js', "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n");
  assert.equal(done.status ?? done.code, 0, `${done.stderr ?? done.err}`);
});

test('the hook judges the index when working files differ in either direction [C7]', () => {
  const bad = "import { readFileSync, existsSync } from 'node:fs';\n";
  const good = "import { readFileSync } from 'node:fs';\n";
  for (const [staged, working, shouldPass] of [[bad, good, false], [good, bad, true]]) {
    const box = staticProject();
    mkdirSync(join(box.repo, 'src'), { recursive: true });
    writeFileSync(join(box.repo, 'src', 'partial.js'), staged);
    box.git(box.repo, 'add', 'src/partial.js');
    writeFileSync(join(box.repo, 'src', 'partial.js'), working);
    const result = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: add a source file');
    assert.equal((result.status ?? result.code) === 0, shouldPass, result.stderr ?? result.err);
  }
});

test('the hook refuses the other named static checks [C7]', () => {
  const examples = [
    ['src/empty.js', 'try { work(); } catch {}\n', /empty catch names no reason/u],
    ['test/input.test.js', "readFileSync(new URL('../src/example.js', import.meta.url));\n", /reads source files without/u],
    ['src/large.js', '// line\n'.repeat(1501), /over the 1500-line cap/u],
  ];
  for (const [file, source, message] of examples) {
    const box = staticProject();
    mkdirSync(join(box.repo, file.substring(0, file.lastIndexOf('/'))), { recursive: true });
    writeFileSync(join(box.repo, file), source);
    box.git(box.repo, 'add', file);
    const refused = box.tryGit(box.repo, 'commit', '-q', '-m', 'bad static');
    assert.notEqual(refused.status ?? refused.code, 0);
    assert.match(`${refused.stderr ?? refused.err}${refused.stdout ?? refused.out ?? ''}`, message);
  }
});
