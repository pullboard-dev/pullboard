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
import { assertShortInit } from '../../tests/fixtures/shortinit.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('cli.journeys-init-gate.init-prints-a-short-summary-and: init prints a short summary and one next step and never suggests killing a process [I1,I2,H5,N26]', async (t) => {
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

/**
 * The gate-availability notes of an `init --json` result, as fields: the command, the places searched and the recipe.
 * Reading the note string is the one place the sentence is taken apart; every case compares fields.
 */
function gateWarnings(run) {
  assert.equal(run.code, 0, run.err || run.out);
  return JSON.parse(run.out).notes.flatMap((note) => {
    const found = /^gate command "([^"]+)" is not available on (.+?); (.+) before running it$/u.exec(note);
    return found ? [{ command: found[1], searched: found[2].split(', '), recipe: found[3] }] : [];
  });
}

test('cli.journeys-init-gate.init-says-when-its-gate-command: init says when its gate command cannot run [I1, I2]', async () => {
  const box = e2e.sandbox();
  for (const name of ['UV_PROJECT_ENVIRONMENT', 'POETRY_ACTIVE', 'POETRY_VIRTUALENVS_PATH', 'VIRTUAL_ENV']) delete box.env[name];
  const path = isolatedPath(box);

  const missingRoot = pythonRepo(box, 'missing-gate');
  const missing = await box.runLocal(missingRoot, 'init', '--json');
  assert.equal(missing.code, 0, missing.err || missing.out);
  const warnings = gateWarnings(missing);
  assert.equal(warnings.length, 1, 'a missing gate gets one actionable note in init --json');
  assert.deepEqual(warnings[0], { command: 'pytest', searched: ['PATH', 'project `.venv`'], recipe: 'install pytest or activate the project `.venv`' });

  const pathRoot = pythonRepo(box, 'path-gate');
  const pathMarker = join(box.dir, 'path-gate-ran');
  writeGateSentinel(join(path, process.platform === 'win32' ? 'pytest.cmd' : 'pytest'), pathMarker);
  const onPath = await box.runLocal(pathRoot, 'init', '--json');
  assert.equal(onPath.code, 0, onPath.err || onPath.out);
  assert.deepEqual(gateWarnings(onPath), []);
  assert.equal(existsSync(pathMarker), false, 'init checks the executable without running the gate');
  rmSync(join(path, process.platform === 'win32' ? 'pytest.cmd' : 'pytest'));

  const environmentRoot = pythonRepo(box, 'venv-gate');
  const environmentMarker = join(box.dir, 'venv-gate-ran');
  const environmentBin = join(environmentRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  mkdirSync(environmentBin, { recursive: true });
  writeGateSentinel(join(environmentBin, process.platform === 'win32' ? 'pytest.cmd' : 'pytest'), environmentMarker);
  const inEnvironment = await box.runLocal(environmentRoot, 'init', '--json');
  assert.equal(inEnvironment.code, 0, inEnvironment.err || inEnvironment.out);
  assert.deepEqual(gateWarnings(inEnvironment), []);
  assert.equal(existsSync(environmentMarker), false, 'init does not execute a gate found in .venv');

  const uvRoot = pythonRepo(box, 'uv-gate');
  const uvMarker = join(box.dir, 'uv-gate-ran');
  const uvEnvironment = join(box.dir, 'uv-environment');
  mkdirSync(join(uvEnvironment, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  writeGateSentinel(join(uvEnvironment, process.platform === 'win32' ? 'Scripts/pytest.cmd' : 'bin/pytest'), uvMarker);
  box.env.UV_PROJECT_ENVIRONMENT = uvEnvironment;
  const inUvEnvironment = await box.runLocal(uvRoot, 'init', '--json');
  assert.equal(inUvEnvironment.code, 0, inUvEnvironment.err || inUvEnvironment.out);
  assert.deepEqual(gateWarnings(inUvEnvironment), []);
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
  const decoy = await box.runLocal(poetryRoot, 'init', '--json');
  assert.equal(decoy.code, 0, decoy.err || decoy.out);
  // A poetry.lock fronts the detected gate with `poetry run` [C7,#10357], so the executable init resolves is poetry, never a same-name cache entry's pytest.
  const poetryNote = 'gate command "poetry" is not available on PATH; install it before running the gate';
  assert.deepEqual(JSON.parse(decoy.out).notes.filter((note) => note.startsWith('gate command')), [poetryNote],
    'a same-name Poetry cache entry is not assumed to belong to this repo');
  assert.equal(existsSync(poetryMarker), false, 'init does not execute a same-name Poetry cache entry');

  delete box.env.POETRY_VIRTUALENVS_PATH;
  writeGateSentinel(join(path, process.platform === 'win32' ? 'poetry.cmd' : 'poetry'), poetryMarker);
  const withPoetry = await box.runLocal(poetryRoot, 'init', '--json');
  assert.equal(withPoetry.code, 0, withPoetry.err || withPoetry.out);
  assert.deepEqual(JSON.parse(withPoetry.out).notes.filter((note) => note.startsWith('gate command')), [],
    'poetry on PATH resolves the fronted gate');
  assert.equal(existsSync(poetryMarker), false, 'init does not execute the poetry that fronts the gate');
  rmSync(join(path, process.platform === 'win32' ? 'poetry.cmd' : 'poetry'));
  const defaultMissing = await box.runLocal(pythonRepo(box, 'default-missing-gate'), 'init');
  // The short-versus-verbose split is a rendering of the same note: init --json carries the whole note either way,
  // so the split is proved on the two text renderings of one note (the summary keeps the warning clause, verbose adds the recipe).
  const shortNote = gateWarnings(await box.runLocal(pythonRepo(box, 'json-missing-gate'), 'init', '--json'))[0];
  assert.equal(shortNote.recipe, 'install pytest or activate the project `.venv`', 'init --json holds the recipe as its own field');
  assert.ok(defaultMissing.out.includes('gate command "pytest" is not available'), 'the short summary preserves a real missing-executable warning');
  assert.ok(!defaultMissing.out.includes(shortNote.recipe), 'detailed recipes stay behind verbose');
});

test('cli.journeys-init-gate.a-repo-without-package-json-is: a repo without package.json is told a gate that fits it [C7,B26]', async () => {
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
  assert.match(initialized.out, /pullboard gate set '<command>'/u);
  const initializedGate = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).gate;
  const pending = await box.runLocal(root, 'resume', '--diagnostics', '--json');
  assert.equal(pending.code, 0, pending.err || pending.out);
  assert.equal(JSON.parse(pending.out).setup.steps.find(step => step.number === 3).done, false,
    'an unknown project keeps its gate choice unanswered');

  // Keep a legacy empty-gate board to exercise the real NO_GATE refusal after init.
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  config.gate = '';
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify(config, null, 2));
  // lane add refuses NO_POLICY until main has a first commit [C7].
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: initialize the no-manifest board');
  const lane = await box.runLocal(root, 'lane', 'add', 'app', '--owns', 'app/');
  assert.equal(lane.code, 0, lane.err || lane.out);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: set up the no-manifest board');

  const added = await fixtureAdd(box.runLocal, root, 'app', 'No-manifest newcomer change',
    '--criterion', 'the result file is present', '--check', 'test -f app/result.txt', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = String(JSON.parse(added.out).item.item_id);
  const worktree = join(box.dir, 'app-agent');
  box.git(root, 'worktree', 'add', '-q', '-b', 'app/one', worktree);
  const joined = await fixtureJoin(box.runLocal, worktree, 'app', '--route', 'strong');
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
  const refiled = await fixtureAdd(box.runLocal, root, 'app', 'Chosen-gate newcomer change',
    '--criterion', 'the result file is present', '--check', 'test -f app/result.txt', '--not-duplicate-of', `${id} refiled under the chosen gate`, '--json');
  assert.equal(refiled.code, 0, refiled.err || refiled.out);
  const configuredId = String(JSON.parse(refiled.out).item.item_id);
  const configuredJoin = await fixtureJoin(box.runLocal, configuredWorktree, 'app', '--route', 'strong');
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
