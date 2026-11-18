/** Init's NO_GATE and per-language gate cases that read a project's Makefile, in their own file so the census runs them apart [C3,I1,B26,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runPrinted } from '../../tests/fixtures/init-printed.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Follow the actual printed setter after proving the same real target fails independently. */
test('cli.journeys-init-gate-makefile.no-gate-preserves-a-failing-makefile: NO_GATE preserves a failing Makefile test with ordinary multiple targets [C3,I1,B26]', async () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'multi-target-project');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const initialized = await box.runLocal(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  const configFile = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: '' }, null, 2));
  writeFileSync(join(root, 'SPEC.md'), '# Make project\n\n## G · Goals\n- G1 [approved, must] Project tests prove the work. | gate: make test\n');
  const marker = join(box.dir, 'make-test-ran');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(root, 'Makefile'), `test check:\n\t@printf tested > ${quote(marker)}\n\t@exit 1\n`);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: prepare a multiple-target Makefile');
  const actual = runFixtureChild('make', ['test'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.notEqual(actual.status, 0, 'the real project target must be red before following any advice');
  assert.equal(readFileSync(marker, 'utf8'), 'tested');
  rmSync(marker);
  const missing = await box.runLocal(root, 'gate', '--json');
  assert.equal(missing.code, 1, missing.err || missing.out);
  const refusal = JSON.parse(missing.out).error;
  assert.equal(refusal.code, 'NO_GATE');
  const printed = /pullboard gate set '[^']*'/u.exec(refusal.next)?.[0];
  assert.ok(printed, 'the current refusal must provide the executable setter');
  const set = await runPrinted(box, root, printed);
  assert.equal(set.status, 0, set.failure || set.stderr || set.stdout);
  assert.equal(existsSync(marker), false, 'detection and configuration must not run the project gate');
  box.git(root, 'add', 'pullboard.json');
  box.git(root, 'commit', '-q', '-m', 'chore: follow printed gate advice');
  const gated = await box.runLocal(root, 'gate', '--json');
  const result = JSON.parse(gated.out);
  console.log(JSON.stringify({ directMakeStatus: actual.status, printed, configured: JSON.parse(readFileSync(configFile, 'utf8')).gate, gateStatus: gated.code, green: result.green, projectTestRan: existsSync(marker) }));
  assert.equal(result.green, false, 'following NO_GATE advice must not pass a real failing multi-target make test');
  assert.notEqual(gated.code, 0);
  assert.equal(readFileSync(marker, 'utf8'), 'tested');
});

test('cli.journeys-init-gate-makefile.no-gate-finds-test-anywhere-in: NO_GATE finds test anywhere in literal Makefile target lists [C3,I1,B26]', async () => {
  for (const [rule, target] of [
    ['check test:', true],
    ['check \\' + '\ntest:', true],
    ['  check test :', true],
    ['test := test check:', false],
    ['all:\n\ttest: recipe-text', false],
  ]) {
    const box = e2e.sandbox();
    const root = join(box.dir, 'make-target-project');
    mkdirSync(root);
    box.git(root, 'init', '-q', '-b', 'main');
    assert.equal((await box.runLocal(root, 'init')).code, 0);
    const configFile = join(root, 'pullboard.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    writeFileSync(configFile, JSON.stringify({ ...config, gate: '' }, null, 2));
    writeFileSync(join(root, 'SPEC.md'), '# Make project\n\n## G · Goals\n- G1 [approved, must] Project tests prove the work. | gate: make test\n');
    const marker = join(box.dir, 'project-test-ran');
    const quoted = "'" + marker.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(root, 'Makefile'), rule + (target ? `\n\t@printf tested > ${quoted}\n\t@exit 1\n` : '\n'));
    box.git(root, 'add', '-A');
    box.git(root, 'commit', '-q', '-m', 'chore: prepare literal Makefile target coverage');
    const direct = runFixtureChild('make', ['test'], { cwd: root, env: box.env, encoding: 'utf8' });
    assert.notEqual(direct.status, 0, 'the real test fails, or make reports no test target');
    assert.equal(existsSync(marker), target, `make itself determines whether ${JSON.stringify(rule)} has our test recipe`);
    if (target) rmSync(marker);
    const missing = await box.runLocal(root, 'gate', '--json');
    assert.equal(missing.code, 1);
    const refusal = JSON.parse(missing.out).error;
    assert.equal(refusal.code, 'NO_GATE');
    const printed = /pullboard gate set '[^']*'/u.exec(refusal.next)?.[0];
    assert.equal(printed, `pullboard gate set '${target ? 'make test' : 'pullboard spec check'}'`, rule);
    const configured = await runPrinted(box, root, printed);
    assert.equal(configured.status, 0, configured.failure || configured.stderr || configured.stdout);
    assert.equal(existsSync(marker), false, 'finding and setting the gate never runs Makefile code');
    box.git(root, 'add', 'pullboard.json');
    box.git(root, 'commit', '-q', '-m', 'chore: use the printed project gate');
    const gated = await box.runLocal(root, 'gate', '--json');
    assert.equal(JSON.parse(gated.out).green, !target, rule);
    assert.equal(existsSync(marker), target, 'only running a real project gate executes its test recipe');
  }
});

test('cli.journeys-init-gate-makefile.init-joins-one-gate-per-detected: init joins one gate per detected language and protects each language\'s test files [C7,B26,#3707]', async () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'mixed-languages');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'composer.json'), '{}\n');
  writeFileSync(join(root, 'mix.exs'), '# mix\n');
  writeFileSync(join(root, 'App.csproj'), '<Project/>\n');
  writeFileSync(join(root, 'CMakeLists.txt'), 'project(app)\n');
  writeFileSync(join(root, 'go.mod'), 'module app\n');
  writeFileSync(join(root, 'pytest.ini'), '[pytest]\n');
  assert.equal((await box.runLocal(root, 'init')).code, 0);
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  assert.equal(config.gate, [
    'go test ./...', 'pytest', 'composer test', 'mix test', 'dotnet test',
    'cmake -S . -B build && cmake --build build && ctest --test-dir build',
  ].join(' && '));
  for (const glob of ['**/*_test.go', '**/test_*.py', '**/*Test.php', '**/*_test.exs', '**/*Tests.cs', '**/*.test.js']) {
    assert.ok(config.claim.barTestFiles.includes(glob), `${glob} is a protected test glob`);
  }
});
