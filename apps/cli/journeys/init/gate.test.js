/** Check that init only resolves the detected gate executable and never runs it [I1, I2]. */
import assert from 'node:assert/strict';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { assertShortInit } from '../../tests/fixtures/shortinit.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('init prints a short summary and one next step and never suggests killing a process [I1,I2,H5,N26]', async (t) => {
  await assertShortInit(t, e2e.sandbox);
});

/** Create a fresh git repository whose detected gate is pytest. */
function pythonRepo(box, name) {
  const root = join(box.dir, name);
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "gate-check-fixture"\n');
  return root;
}

/** Keep git available while excluding unrelated host commands from this init process's PATH. */
function isolatedPath(box, name = 'isolated-path') {
  const source = (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, process.platform === 'win32' ? 'git.exe' : 'git'))
    .find((file) => {
      try {
        const info = statSync(file);
        if (!info.isFile()) return false;
        accessSync(file, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  assert.ok(source, 'the test runner has git available on its PATH');
  const path = join(box.dir, name);
  mkdirSync(path);
  symlinkSync(source, join(path, process.platform === 'win32' ? 'git.exe' : 'git'));
  box.env.PATH = path;
  return path;
}

/** Write a harmless executable sentinel so the test can detect an accidental gate invocation. */
function writeGateSentinel(file, marker) {
  const quotedMarker = `'${marker.replaceAll("'", "'\\''")}'`;
  writeFileSync(file, `#!/bin/sh\nprintf invoked > ${quotedMarker}\n`);
  chmodSync(file, 0o755);
}

test('init says when its gate command cannot run [I1, I2]', async () => {
  const box = e2e.sandbox();
  for (const name of ['UV_PROJECT_ENVIRONMENT', 'POETRY_ACTIVE', 'POETRY_VIRTUALENVS_PATH', 'VIRTUAL_ENV']) delete box.env[name];
  const path = isolatedPath(box);

  const missingRoot = pythonRepo(box, 'missing-gate');
  const missing = await box.runLocal(missingRoot, 'init', '--verbose');
  assert.equal(missing.code, 0, missing.err || missing.out);
  const warnings = missing.out.split(/\r?\n/u).filter((line) => line.includes('gate command "pytest" is not available'));
  assert.equal(warnings.length, 1, 'a missing gate gets one actionable line');
  assert.match(warnings[0], /install pytest or activate the project `\.venv`/u);

  const pathRoot = pythonRepo(box, 'path-gate');
  const pathMarker = join(box.dir, 'path-gate-ran');
  writeGateSentinel(join(path, process.platform === 'win32' ? 'pytest.cmd' : 'pytest'), pathMarker);
  const onPath = await box.runLocal(pathRoot, 'init', '--verbose');
  assert.equal(onPath.code, 0, onPath.err || onPath.out);
  assert.doesNotMatch(onPath.out, /gate command "pytest" is not available/u);
  assert.equal(existsSync(pathMarker), false, 'init checks the executable without running the gate');
  rmSync(join(path, process.platform === 'win32' ? 'pytest.cmd' : 'pytest'));

  const environmentRoot = pythonRepo(box, 'venv-gate');
  const environmentMarker = join(box.dir, 'venv-gate-ran');
  const environmentBin = join(environmentRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  mkdirSync(environmentBin, { recursive: true });
  writeGateSentinel(join(environmentBin, process.platform === 'win32' ? 'pytest.cmd' : 'pytest'), environmentMarker);
  const inEnvironment = await box.runLocal(environmentRoot, 'init', '--verbose');
  assert.equal(inEnvironment.code, 0, inEnvironment.err || inEnvironment.out);
  assert.doesNotMatch(inEnvironment.out, /gate command "pytest" is not available/u);
  assert.equal(existsSync(environmentMarker), false, 'init does not execute a gate found in .venv');

  const uvRoot = pythonRepo(box, 'uv-gate');
  const uvMarker = join(box.dir, 'uv-gate-ran');
  const uvEnvironment = join(box.dir, 'uv-environment');
  mkdirSync(join(uvEnvironment, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  writeGateSentinel(join(uvEnvironment, process.platform === 'win32' ? 'Scripts/pytest.cmd' : 'bin/pytest'), uvMarker);
  box.env.UV_PROJECT_ENVIRONMENT = uvEnvironment;
  const inUvEnvironment = await box.runLocal(uvRoot, 'init', '--verbose');
  assert.equal(inUvEnvironment.code, 0, inUvEnvironment.err || inUvEnvironment.out);
  assert.doesNotMatch(inUvEnvironment.out, /gate command "pytest" is not available/u);
  assert.equal(existsSync(uvMarker), false, 'init does not execute a gate found in the configured uv environment');
  delete box.env.UV_PROJECT_ENVIRONMENT;

  const poetryRoot = pythonRepo(box, 'poetry-gate');
  writeFileSync(join(poetryRoot, 'poetry.lock'), '');
  const poetryMarker = join(box.dir, 'poetry-gate-ran');
  const poetryCache = join(box.dir, 'poetry-environments');
  const decoyEnvironment = join(poetryCache, 'gate-check-fixture-a1b2-py3.12');
  mkdirSync(join(decoyEnvironment, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  writeGateSentinel(join(decoyEnvironment, process.platform === 'win32' ? 'Scripts/pytest.cmd' : 'bin/pytest'), poetryMarker);
  box.env.POETRY_VIRTUALENVS_PATH = poetryCache;
  const decoy = await box.runLocal(poetryRoot, 'init', '--verbose');
  assert.equal(decoy.code, 0, decoy.err || decoy.out);
  assert.match(decoy.out, /gate command "pytest" is not available on PATH, project `\.venv`/u,
    'a same-name Poetry cache entry is not assumed to belong to this repo');
  assert.match(decoy.out, /run `poetry install` and activate that environment/u);
  assert.equal(existsSync(poetryMarker), false, 'init does not execute a same-name Poetry cache entry');

  delete box.env.POETRY_VIRTUALENVS_PATH;
  const activePoetry = join(box.dir, 'active-poetry-environment');
  mkdirSync(join(activePoetry, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  writeGateSentinel(join(activePoetry, process.platform === 'win32' ? 'Scripts/pytest.cmd' : 'bin/pytest'), poetryMarker);
  box.env.POETRY_ACTIVE = '1';
  box.env.VIRTUAL_ENV = activePoetry;
  const inPoetryEnvironment = await box.runLocal(poetryRoot, 'init', '--verbose');
  assert.equal(inPoetryEnvironment.code, 0, inPoetryEnvironment.err || inPoetryEnvironment.out);
  assert.doesNotMatch(inPoetryEnvironment.out, /gate command "pytest" is not available/u,
    'an explicitly active Poetry environment is checked');
  assert.equal(existsSync(poetryMarker), false, 'init does not execute a gate found in the active Poetry environment');
  delete box.env.POETRY_ACTIVE;
  delete box.env.VIRTUAL_ENV;
  const defaultMissing = await box.runLocal(pythonRepo(box, 'default-missing-gate'), 'init');
  assert.match(defaultMissing.out, /gate command "pytest" is not available/u, 'the short summary preserves a real missing-executable warning');
  assert.doesNotMatch(defaultMissing.out, /install pytest|pullboard gate set/u, 'detailed recipes stay behind verbose');
});

test('a repo without package.json is told a gate that fits it [C7,B26]', async () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'no-package');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'app'));
  const marker = join(box.dir, 'project-gate-ran');
  writeFileSync(join(root, 'app', 'project-check.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'tested\\n');\n`);

  const initialized = await box.runLocal(root, 'init', '--verbose');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  assert.equal(existsSync(join(root, 'package.json')), false, 'the newcomer repo has no package manifest');
  assert.equal(existsSync(marker), false, 'init does not execute a project command it has not detected');
  assert.match(initialized.out, /ask the person which command tests this project/u);
  const initializedGate = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).gate;
  const pending = await box.runLocal(root, 'resume', '--diagnostics', '--json');
  assert.equal(pending.code, 0, pending.err || pending.out);
  assert.equal(JSON.parse(pending.out).setup.steps.find(step => step.number === 3).done, false,
    'an unknown project keeps its gate choice unanswered');

  // Keep a legacy empty-gate board to exercise the real NO_GATE refusal after init.
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  config.gate = '';
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify(config, null, 2));
  const lane = await box.runLocal(root, 'lane', 'add', 'app', '--owns', 'app/');
  assert.equal(lane.code, 0, lane.err || lane.out);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: set up the no-manifest board');

  const added = fixtureAdd(box.run, root, 'app', 'No-manifest newcomer change',
    '--criterion', 'the result file is present', '--check', 'test -f app/result.txt', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = String(JSON.parse(added.out).item.item_id);
  const worktree = join(box.dir, 'app-agent');
  box.git(root, 'worktree', 'add', '-q', '-b', 'app/one', worktree);
  const joined = fixtureJoin(box.run, worktree, 'app', '--route', 'strong');
  assert.equal(joined.code, 0, joined.err || joined.out);
  const claimed = await box.runLocal(worktree, 'claim', id, '--json');
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  mkdirSync(join(worktree, 'app'), { recursive: true });
  writeFileSync(join(worktree, 'app', 'result.txt'), 'done\n');
  box.git(worktree, 'add', 'app/result.txt');
  box.git(worktree, 'commit', '-q', '-m', 'chore: finish the newcomer change');

  const submitted = await box.runLocal(worktree, 'submit', id, '--json');
  assert.equal(submitted.code, 1, submitted.err || submitted.out);
  const refusal = JSON.parse(submitted.out).error;
  assert.equal(refusal.code, 'NO_GATE', submitted.out);
  assert.deepEqual({
    initializedGate,
    refusalCode: refusal.code,
    nextNamesInitCommand: /pullboard spec check/u.test(refusal.next),
    nextNamesUnavailableNpm: /\bnpm test\b/u.test(refusal.next),
  }, {
    initializedGate: '',
    refusalCode: 'NO_GATE',
    nextNamesInitCommand: true,
    nextNamesUnavailableNpm: false,
  });

  const chosenConfig = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  chosenConfig.gate = 'node app/project-check.mjs';
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify(chosenConfig, null, 2));
  box.git(root, 'add', 'pullboard.json');
  box.git(root, 'commit', '-q', '-m', 'chore: choose the project test command');
  const chosen = await box.runLocal(root, 'resume', '--diagnostics', '--json');
  assert.equal(chosen.code, 0, chosen.err || chosen.out);
  assert.equal(JSON.parse(chosen.out).setup.steps.find(step => step.number === 3).done, true,
    'the person choosing an actual project command completes the gate step');
  assert.equal(existsSync(marker), false, 'choosing a gate does not run it');
  const released = await box.runLocal(worktree, 'release', id, '--reason', 'BLOCKED', '--json');
  assert.equal(released.code, 0, released.err || released.out);
  const configuredWorktree = join(box.dir, 'configured-app-agent');
  box.git(root, 'worktree', 'add', '-q', '-b', 'app/chosen', configuredWorktree, 'main');
  // 1388ce262a: an item frozen under the empty gate refuses its claim once the gate policy changes, so the chosen gate gets a fresh item.
  const refiled = fixtureAdd(box.run, root, 'app', 'Chosen-gate newcomer change',
    '--criterion', 'the result file is present', '--check', 'test -f app/result.txt', '--json');
  assert.equal(refiled.code, 0, refiled.err || refiled.out);
  const configuredId = String(JSON.parse(refiled.out).item.item_id);
  const configuredJoin = fixtureJoin(box.run, configuredWorktree, 'app', '--route', 'strong');
  assert.equal(configuredJoin.code, 0, configuredJoin.err || configuredJoin.out);
  const configuredClaim = await box.runLocal(configuredWorktree, 'claim', configuredId, '--json');
  assert.equal(configuredClaim.code, 0, configuredClaim.err || configuredClaim.out);
  writeFileSync(join(configuredWorktree, 'app', 'result.txt'), 'done\n');
  box.git(configuredWorktree, 'add', 'app/result.txt');
  box.git(configuredWorktree, 'commit', '-q', '-m', 'chore: finish with the chosen project test');
  const completed = await box.runLocal(configuredWorktree, 'submit', configuredId, '--json');
  assert.equal(completed.code, 0, completed.err || completed.out);
  assert.equal(readFileSync(marker, 'utf8'), 'tested\n', 'submit runs the chosen project test');
});

test('the gate is set with one pullboard command [I1,A1,B26]', async () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'one-gate-command');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const initialized = await box.runLocal(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);

  const configFile = join(root, 'pullboard.json');
  const initial = JSON.parse(readFileSync(configFile, 'utf8'));
  initial.gate = '';
  initial.lanes.checks = { owns: ['checks/'] };
  initial.fixtureSetting = { kept: ['spaces and "quotes"', { nested: true }] };
  writeFileSync(configFile, JSON.stringify(initial, null, 2) + '\n');
  writeFileSync(join(root, 'SPEC.md'), "# Gate project\n\n## G \u00b7 Goals\n- G1 [approved, must] The project gate checks the work. | gate: test\n");
  mkdirSync(join(root, 'checks'));
  const marker = join(box.dir, 'chosen gate ran.json');
  const checker = join(root, 'checks', 'project check.mjs');
  writeFileSync(checker, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: prepare a board without a gate');

  const resumed = await box.runLocal(root, 'resume', '--diagnostics', '--json');
  assert.equal(resumed.code, 0, resumed.err || resumed.out);
  assert.equal(JSON.parse(resumed.out).setup.step, 3);
  const step = JSON.parse(resumed.out).setup.steps.find(entry => entry.number === 3);
  assert.equal(step.done, false);
  assert.match(step.command, /^pullboard gate set /u);
  assert.doesNotMatch(step.command, /node -e|writeFileSync/u);
  const resumedText = await box.runLocal(root, 'resume', '--diagnostics');
  assert.equal(resumedText.code, 0, resumedText.err || resumedText.out);
  assert.ok(resumedText.out.includes(step.command));
  assert.doesNotMatch(resumedText.out, /node -e.*pullboard\.json/u);
  const missing = await box.runLocal(root, 'gate', '--json');
  assert.equal(missing.code, 1, missing.err || missing.out);
  const refusal = JSON.parse(missing.out).error;
  assert.equal(refusal.code, 'NO_GATE');
  assert.match(refusal.next, /pullboard gate set/u);
  assert.doesNotMatch(refusal.next, /node -e/u);

  /** Quote each shell word while retaining the entire configured command as one CLI argument. */
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const argument = `proof with spaces, "double quotes" and 'single quotes'`;
  const command = [process.execPath, checker, argument].map(quote).join(' ');
  const before = JSON.parse(readFileSync(configFile, 'utf8'));
  const configured = await box.runLocal(root, 'gate', 'set', command, '--json');
  assert.equal(configured.code, 0, configured.err || configured.out);
  assert.equal(JSON.parse(configured.out).gate, command);
  assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), { ...before, gate: command });
  assert.equal(existsSync(marker), false, 'setting the command neither executes it nor stamps it green');
  const answered = await box.runLocal(root, 'resume', '--diagnostics', '--json');
  assert.equal(answered.code, 0, answered.err || answered.out);
  assert.equal(JSON.parse(answered.out).setup.steps.find(entry => entry.number === 3).done, true);

  // The normal gate trusts committed coordinator policy, so commit the chosen answer first.
  box.git(root, 'add', 'pullboard.json');
  box.git(root, 'commit', '-q', '-m', 'chore: choose the project gate');
  const gated = await box.runLocal(root, 'gate', '--json');
  assert.equal(gated.code, 0, gated.err || gated.out);
  assert.equal(JSON.parse(gated.out).green, true);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), [argument]);
});

test('NO_GATE names the project test before a spec-only fallback [I1,C3,B26]', async () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'red-make-project');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const initialized = await box.runLocal(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  const marker = join(box.dir, 'make-test-ran');
  const quotedMarker = `'${marker.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(root, 'Makefile'), `test:\n\t@printf tested > ${quotedMarker}\n\t@exit 1\n`);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: prepare a project with a failing test');

  const missing = await box.runLocal(root, 'gate', '--json');
  assert.equal(missing.code, 1, missing.err || missing.out);
  const refusal = JSON.parse(missing.out).error;
  assert.equal(refusal.code, 'NO_GATE');
  const suggested = /pullboard gate set '[^']*'/u.exec(refusal.next)?.[0];
  assert.equal(suggested, "pullboard gate set 'make test'", 'the next step keeps the actual project test');
  assert.doesNotMatch(refusal.next, /pullboard spec check/u, 'a known test command is not replaced with a spec check');
  assert.equal(existsSync(marker), false, 'finding a test command never executes it');
  const configured = runFixtureChild('sh', ['-c', suggested], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(configured.status, 0, configured.failure || configured.stderr || configured.stdout);
  assert.equal(JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).gate, 'make test');
  assert.equal(existsSync(marker), false, 'the printed setter does not execute the test');
  box.git(root, 'add', 'pullboard.json');
  box.git(root, 'commit', '-q', '-m', 'chore: record the printed project gate');
  const gated = await box.runLocal(root, 'gate', '--json');
  assert.equal(gated.code, 1, gated.err || gated.out);
  assert.equal(JSON.parse(gated.out).green, false, 'following the advice cannot certify red project tests');
  assert.equal(readFileSync(marker, 'utf8'), 'tested', 'the real Makefile target ran');
});

test('gate set keeps configuration in the coordinator checkout [I1,L3,B26]', async () => {
  const box = e2e.project();
  const mainFile = join(box.repo, 'pullboard.json');
  const laneFile = join(box.web, 'pullboard.json');
  const mainBefore = readFileSync(mainFile, 'utf8');
  const laneBefore = readFileSync(laneFile, 'utf8');
  const forbidden = await box.runLocal(box.web, 'gate', 'set', 'echo changed', '--json');
  assert.equal(forbidden.code, 1, forbidden.err || forbidden.out);
  const refusal = JSON.parse(forbidden.out).error;
  assert.equal(refusal.code, 'NOT_MAIN');
  assert.match(refusal.next, /ask the coordinator.*pullboard gate set/u);
  assert.equal(readFileSync(mainFile, 'utf8'), mainBefore);
  assert.equal(readFileSync(laneFile, 'utf8'), laneBefore);

  for (const args of [[], [''], ['   '], ['echo', 'split'], ['echo ok', '--landing']]) {
    const invalid = await box.runLocal(box.repo, 'gate', 'set', ...args, '--json');
    assert.equal(invalid.code, 1, invalid.err || invalid.out);
    assert.equal(JSON.parse(invalid.out).error.code, 'USAGE');
    assert.match(JSON.parse(invalid.out).error.next, /pullboard gate set/u);
    assert.equal(readFileSync(mainFile, 'utf8'), mainBefore, 'a malformed setter leaves all configuration alone');
  }
});

/** Follow the actual printed setter after proving the same real target fails independently. */
test('NO_GATE preserves a failing Makefile test with ordinary multiple targets [C3,I1,B26]', async () => {
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
  const set = runFixtureChild('sh', ['-c', printed], { cwd: root, env: box.env, encoding: 'utf8' });
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

test('NO_GATE finds test anywhere in literal Makefile target lists [C3,I1,B26]', async () => {
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
    const configured = runFixtureChild('sh', ['-c', printed], { cwd: root, env: box.env, encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.failure || configured.stderr || configured.stdout);
    assert.equal(existsSync(marker), false, 'finding and setting the gate never runs Makefile code');
    box.git(root, 'add', 'pullboard.json');
    box.git(root, 'commit', '-q', '-m', 'chore: use the printed project gate');
    const gated = await box.runLocal(root, 'gate', '--json');
    assert.equal(JSON.parse(gated.out).green, !target, rule);
    assert.equal(existsSync(marker), target, 'only running a real project gate executes its test recipe');
  }
});
