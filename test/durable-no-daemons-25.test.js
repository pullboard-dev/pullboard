/** No process is load-bearing: the changed-file static check refuses new daemons and state files outside the drive, transport, jobs and pin cells [C7]. */
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { LOAD_BEARING_CEILINGS } from '../packages/gate/index.js';
import { loadBearingFailures } from '../packages/gate/index.js';
import { loadBearingSites } from '../packages/gate/index.js';

const helpers = createE2eHelpers();
after(() => helpers.cleanup());

const REAL = join(import.meta.dirname, '..', 'bin', 'checks');

const DAEMON = [
  "import { spawn } from 'node:child_process';",
  'export async function start(pause) {',
  "  const child = spawn('sh', ['-c', 'sleep 9'], { detached: true, stdio: 'ignore' });",
  '  child.unref();',
  '  setInterval(() => {}, 1000);',
  '  while (true) { await pause(); }',
  '}',
  '',
].join('\n');

const STATE = [
  "import { writeFileSync } from 'node:fs';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  "export function save(commonDir, value) { writeFileSync(join(commonDir, 'pullboard', 'mine.json'), value); }",
  "export function cache(value) { writeFileSync(join(tmpdir(), 'mine.json'), value); }",
  '',
].join('\n');

/** The kinds the check reports for one source at one path. */
function kinds(source, path) {
  return loadBearingSites(source, path).map(site => site.kind);
}

/** A real project whose staged checker is the repository's own changed-file list, with a ceilings file on main. */
function ceilingProject(ceilings) {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  mkdirSync(join(box.repo, 'bin', 'checks'), { recursive: true });
  copyFileSync(join(REAL, 'test-waits-baseline.json'), join(box.repo, 'bin', 'checks', 'test-waits-baseline.json'));
  writeFileSync(join(box.repo, 'bin', 'checks', 'changed-static.js'), [
    `import { stagedHookFailures } from ${JSON.stringify(pathToFileURL(join(REAL, 'changed-static.js')).href)};`,
    "const failures = stagedHookFailures(process.cwd());",
    "if (failures.length) { process.stderr.write(failures.join('\\n') + '\\n'); process.exitCode = 1; }", ''].join('\n'));
  write(box, LOAD_BEARING_CEILINGS, JSON.stringify(ceilings, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: record the load-bearing ceilings');
  return box;
}

/** Write one file under the project. */
function write(box, file, text) {
  mkdirSync(dirname(join(box.repo, file)), { recursive: true });
  writeFileSync(join(box.repo, file), text);
}

/** Stage the files and run the staged checker the pre-commit hook and the gate share. */
function stageAndCheck(box, files) {
  for (const [file, text] of Object.entries(files)) write(box, file, text);
  box.git(box.repo, 'add', '--', ...Object.keys(files));
  const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
    join(box.repo, 'bin/checks/changed-static.js')], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  return { status: run.status, out: `${run.stderr}${run.stdout}` };
}

test('clause 1: a detached child, an unref and a daemon loop outside the drive, transport, jobs and pin cells are refused [C7]', () => {
  assert.deepEqual(kinds(DAEMON, 'packages/items/src/shell/daemon.js'), ['detached', 'unref', 'daemon-loop', 'daemon-loop']);
  for (const cell of ['drive', 'transport', 'jobs', 'pin']) assert.deepEqual(kinds(DAEMON, `packages/${cell}/src/shell/daemon.js`), [], `the ${cell} cell owns processes`);
  assert.deepEqual(kinds(DAEMON, 'packages/items/tests/daemon.test.js'), [], 'tests are not judged');
  assert.deepEqual(kinds("spawn('sh', [], { detached: false });\nfor (;;) { if (step()) break; }\n", 'src/x.js'), [], 'an attached child and a loop with no await are not daemons');
  const refused = loadBearingFailures([{ file: 'packages/items/src/shell/daemon.js', source: DAEMON }], {});
  assert.equal(refused.length, 4);
  assert.match(refused[0], /^packages\/items\/src\/shell\/daemon\.js:3: load-bearing detached: .* make the work a job the drive cell runs/u);
});

test('clause 1: a state file under .git/pullboard or the OS temp folder outside the four cells is refused [C7]', () => {
  assert.deepEqual(kinds(STATE, 'apps/cli/src/shell/state.js'), ['state-file', 'state-file']);
  assert.deepEqual(kinds(STATE, 'packages/pin/src/shell/state.js'), [], 'the pin cell owns keyed caches');
  assert.deepEqual(kinds("import { writeFileSync } from 'node:fs';\nexport const put = (dir, v) => writeFileSync(dir + '/out.txt', v);\n", 'src/out.js'), [], 'a write that names no state root is not a state file');
  assert.match(loadBearingFailures([{ file: 'apps/cli/src/shell/state.js', source: STATE }], {}).join('\n'), /apps\/cli\/src\/shell\/state\.js:4: load-bearing state-file/u);
});

test('clause 1: existing sites sit in a ceiling that only falls, and the shared staged check enforces it [C7]', () => {
  const file = 'packages/items/src/shell/daemon.js';
  const box = ceilingProject({ [file]: { detached: 1, unref: 1, 'daemon-loop': 2 } });
  assert.equal(stageAndCheck(box, { [file]: DAEMON }).status, 0, 'sites within the ceiling pass');
  const grown = stageAndCheck(box, { [file]: DAEMON.replace('  child.unref();', '  child.unref();\n  child.unref();') });
  assert.notEqual(grown.status, 0);
  assert.match(grown.out, /packages\/items\/src\/shell\/daemon\.js:\d+: load-bearing unref/u);
  const fresh = stageAndCheck(box, { [file]: DAEMON, 'src/new-daemon.js': DAEMON });
  assert.match(fresh.out, /src\/new-daemon\.js:3: load-bearing detached/u, 'a file the ceilings do not list allows none');
  box.git(box.repo, 'rm', '-q', '--cached', 'src/new-daemon.js');
  const raised = stageAndCheck(box, { [file]: DAEMON, [LOAD_BEARING_CEILINGS]: JSON.stringify({ [file]: { detached: 2, unref: 1, 'daemon-loop': 2 } }) });
  assert.notEqual(raised.status, 0);
  assert.match(raised.out, /load-bearing ceiling for packages\/items\/src\/shell\/daemon\.js detached rose from 1 to 2; the ceiling only falls/u);
  const lowered = stageAndCheck(box, { [file]: DAEMON.replace('  child.unref();\n', ''), [LOAD_BEARING_CEILINGS]: JSON.stringify({ [file]: { detached: 1, 'daemon-loop': 2 } }) });
  assert.equal(lowered.status, 0, `a ceiling may fall: ${lowered.out}`);
});

test('clause 1: the repository ceilings list every existing site, so main passes its own check [C7]', () => {
  const root = join(import.meta.dirname, '..');
  const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', join(REAL, 'changed-static.js'),
    LOAD_BEARING_CEILINGS, 'apps/lib/src/shell/submit-handoff-worker.js', 'packages/resources/src/shell/handoff-worker-cap.js', 'packages/gate/src/core/load-bearing.js'], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(`${run.stderr}`, /load-bearing/u, run.stderr);
});
