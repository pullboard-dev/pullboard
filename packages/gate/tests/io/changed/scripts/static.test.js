/** @pullboard-test-input source-tree */
/** The explicit staged checker runs the gate's changed-file static checks on staged files, so a static red never costs a gate run [C7]. */
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { spawnSync } from 'node:child_process';

const cleanups = [];
after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
/** The module-level owner of each cell project's cleanup, for helpers that run outside a test context. */
const owner = { after: cleanup => cleanups.push(cleanup) };

const ROOT = join(import.meta.dirname, '../../../../../..');
/** The repository's own staged checker and its test-waits baseline: what bin/checks held before the layout move. */
const CHECKER = join(ROOT, 'packages/gate/src/io/changed/scripts/static.js');
const BASELINE = join(ROOT, 'packages/gate/data/baselines/test-waits-baseline.json');

/** A project whose static checks name the repository checker; its shared list is the real module, so hook and gate cannot drift. */
function staticProject(accepted = {}) {
  const box = cellProject(owner, { gate: 'true' });
  for (const [file, source] of Object.entries(accepted)) {
    mkdirSync(join(box.repo, file, '..'), { recursive: true });
    writeFileSync(join(box.repo, file), source);
  }
  if (Object.keys(accepted).length) {
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: record existing source before static policy');
  }
  mkdirSync(join(box.repo, 'packages/gate/data/baselines'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/gate/src/io/changed/scripts'), { recursive: true });
  copyFileSync(BASELINE, join(box.repo, 'packages/gate/data/baselines/test-waits-baseline.json'));
  writeFileSync(join(box.repo, 'packages/gate/src/io/changed/scripts/static.js'), [
    `import { changedStaticFailures, stagedHookFailures } from ${JSON.stringify(pathToFileURL(CHECKER).href)};`,
    "const failures = process.argv[2] === '--staged-hook' ? stagedHookFailures(process.cwd()) : changedStaticFailures(process.cwd(), process.argv.slice(3), { staged: process.argv[2] === '--staged' });",
    "if (failures.length) { process.stderr.write(failures.join('\\n') + '\\n'); process.exitCode = 1; }", ''].join('\n'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...JSON.parse(box.git(box.repo, 'show', 'HEAD:pullboard.json')), gate: 'true',
    staticChecks: 'node apps/cli/src/io/static/checks.js' }, null, 2));
  return box;
}

/** Run the canonical staged checker itself; hook installation belongs to the coordinator's later change. */
function runChecker(box) {
  return spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
    join(box.repo, 'packages/gate/src/io/changed/scripts/static.js'), '--staged-hook'], { cwd: box.repo, env: box.env, encoding: 'utf8' });
}

/** Stage one source file and judge its exact index bytes. */
function stageSource(box, file, source) {
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, file), source);
  box.git(box.repo, 'add', file);
  return runChecker(box);
}

test('the shared changed-file list passes a clean file [C7]', () => {
  const dir = join(import.meta.dirname, '../../../../../..');
  const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', CHECKER, 'packages/gate/src/io/changed/scripts/static.js'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('the staged checker refuses a source with two import bindings on one line, using the gate message [C7]', () => {
  const box = staticProject();
  const started = performance.now();
  const refused = stageSource(box, 'src/two.js', "import { readFileSync, existsSync } from 'node:fs';\nexport const a = [readFileSync, existsSync];\n");
  assert.ok(performance.now() - started < 1000, 'static refusal finishes under one second'); // budget: item #2571's frozen requirement sets the one-second ceiling.
  assert.notEqual(refused.status ?? refused.code, 0, 'the staged source is refused');
  assert.match(`${refused.stderr ?? refused.err}${refused.stdout ?? refused.out ?? ''}`, /src\/two\.js:1: one import binding per line \(2 bindings\)/u);
});

test('clause 1, clause 2: the repository pre-commit step splits a fixable binding line in place, says so, and passes on the first try [C7]', () => {
  const box = staticProject();
  mkdirSync(join(box.repo, 'packages/gate'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/gate/two.js'), "import { readFileSync, existsSync } from 'node:fs';\nexport const a = [readFileSync, existsSync];\n");
  box.git(box.repo, 'add', 'packages/gate/two.js');
  const step = () => runChecker(box);
  const first = step();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /pullboard pre-commit: fixed: split multi-binding import lines in packages\/gate\/two\.js and staged them/u);
  assert.equal(box.git(box.repo, 'show', ':packages/gate/two.js').trimEnd(), "import {\n  readFileSync,\n  existsSync,\n} from 'node:fs';\nexport const a = [readFileSync, existsSync];");
  const second = step();
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /fixed:/u, 'a fixed file is never fixed or refused again');
});

test('the staged checker accepts a clean staged file [C7]', () => {
  const box = staticProject();
  const done = stageSource(box, 'src/one.js', "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n");
  assert.equal(done.status ?? done.code, 0, `${done.stderr ?? done.err}`);
});

test('the staged checker judges the index when working files differ in either direction [C7]', () => {
  const bad = "import { readFileSync, existsSync } from 'node:fs';\n";
  const good = "import { readFileSync } from 'node:fs';\n";
  for (const [staged, working, shouldPass] of [[bad, good, false], [good, bad, true]]) {
    const box = staticProject();
    mkdirSync(join(box.repo, 'src'), { recursive: true });
    writeFileSync(join(box.repo, 'src/partial.js'), staged);
    box.git(box.repo, 'add', 'src/partial.js');
    writeFileSync(join(box.repo, 'src/partial.js'), working);
    const result = runChecker(box);
    assert.equal((result.status ?? result.code) === 0, shouldPass, result.stderr ?? result.err);
  }
});

test('the staged checker refuses the other named static checks [C7]', () => {
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
    const refused = runChecker(box);
    assert.notEqual(refused.status ?? refused.code, 0);
    assert.match(`${refused.stderr ?? refused.err}${refused.stdout ?? refused.out ?? ''}`, message);
  }
});


test('the shared checker and gate ratchet accepted oversized files without accepting new or growing excess [C7]', () => {
  const file = 'src/existing-large.js';
  const source = '// accepted line\n'.repeat(1501);
  for (const lines of [1501, 1500, 1601]) {
    const box = staticProject({ [file]: source });
    const candidate = '// edited line\n'.repeat(lines);
    const result = stageSource(box, file, candidate);
    assert.equal(result.status === 0, lines <= 1501, result.stderr);
    if (lines > 1501) assert.match(result.stderr + result.stdout, /over the 1500-line cap/u);
  }
  const fresh = staticProject();
  const refused = stageSource(fresh, 'src/new-large.js', source);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /over the 1500-line cap/u);
});

test('same-count accepted empty catches and source-reader declarations retain gate parity [C7]', () => {
  const examples = [
    ['src/debt.js', 'try { first(); } catch {}\n', 'try { second(); } catch {}\n', 'try { first(); } catch {} try { second(); } catch {}\n'],
    ['test/debt.test.js', "readFileSync(new URL('../src/first.js', import.meta.url));\n", "readFileSync(new URL('../src/second.js', import.meta.url));\n", null],
  ];
  for (const [file, accepted, same, grown] of examples) {
    const box = staticProject({ [file]: accepted });
    const done = stageSource(box, file, same);
    assert.equal(done.status, 0, done.stderr);
    if (grown) {
      const refused = stageSource(box, file, grown);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr + refused.stdout, /empty catch names no reason/u);
    }
  }
});
