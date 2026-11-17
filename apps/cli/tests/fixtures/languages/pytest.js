/** Shared scratch-project board for the pytest journeys: pytest lookup, a pytest project board with one seat, build-and-submit and accept-and-land [C7,#10616]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { settleLand } from '../land/settle.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import { verifySettled } from '../submit/settle.js';
import { joinFixtureSeat } from '../testkit.js';
import { fileFixtureItem } from '../testkit.js';
import { fixtureProjectPolicy } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../../../../packages/gate/tests/fixtures/testkit.js';

/** The account's real home: a runner job's fresh HOME hides the user site-packages where pip --user put pytest. */
const REAL_HOME = userInfo().homedir || homedir();

/**
 * The environment a gate needs to run pytest, or null when this machine's python3 has no pytest.
 * Why: pip --user installs pytest under the account's user base, which a runner job's fresh HOME hides, and its script folder is on no job PATH;
 * PYTHONUSERBASE points python3 back at it and the script folder joins PATH, the way the Rust journeys point at the account's rustup [#10616].
 */
function pytestEnvironment() {
  const base = spawnSync('python3', ['-c', 'import site; print(site.getuserbase())'], { env: { ...process.env, HOME: REAL_HOME }, encoding: 'utf8', timeout: 10_000 });
  const userBase = String(base.stdout ?? '').trim();
  const env = userBase.startsWith('/') ? { ...process.env, PYTHONUSERBASE: userBase } : process.env;
  const probe = spawnSync('python3', ['-m', 'pytest', '--version'], { env, encoding: 'utf8', timeout: 30_000 });
  if (probe.error || probe.status !== 0) return null;
  const scripts = spawnSync('python3', ['-c', "import sysconfig; print(sysconfig.get_path('scripts')); print(sysconfig.get_path('scripts', 'posix_user'))"], { env, encoding: 'utf8', timeout: 10_000 });
  const folders = String(scripts.stdout).split('\n').map((line) => line.trim()).filter((folder) => folder.startsWith('/') && existsSync(join(folder, 'pytest')));
  if (!folders.length) return null;
  return { folders: [folders[0]], ...(env.PYTHONUSERBASE ? { PYTHONUSERBASE: env.PYTHONUSERBASE } : {}) };
}

export const PYTEST = pytestEnvironment();
export const UNAVAILABLE = 'python3 with a pytest script unavailable on this machine';
export const GATE = 'pytest';

const BRIEF = 'Files:\n- test_item.py\nChange:\n- Add the item test.\nTest:\n- pytest passes.';
/** An item check that fails on main and passes once the item's test is committed; it avoids the test name, so only the gate output can name it. */
const CHECK = "grep -q 'add(1, 2)' test_item.py";
const CALC = 'def add(a, b):\n    return a + b\n';
const HEADER = 'from calc import add\n\n\n';
export const PASSING = `${HEADER}def test_adds_small_numbers():\n    assert add(1, 2) == 3\n`;
export const BROKEN = `${HEADER}def test_adds_small_numbers():\n    assert add(1, 2) == 4\n`;
const BASE_ITEM = `${HEADER}def test_adds_nothing():\n    assert add(0, 0) == 0\n`;

/** A sandbox whose gate and runner see pytest and its user site-packages and write no bytecode: the variables are set before the first command starts the runner. */
export function pytestSandbox(helpers, settings = {}) {
  const box = helpers.sandbox();
  box.env.PATH = [...(PYTEST?.folders ?? []), box.env.PATH].join(':');
  if (PYTEST?.PYTHONUSERBASE) box.env.PYTHONUSERBASE = PYTEST.PYTHONUSERBASE;
  box.env.PYTHONDONTWRITEBYTECODE = '1';
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  return box;
}

/** Write the scratch project's files into a folder: pytest.ini is the pytest signal. */
export function writeProject(root) {
  for (const [path, text] of [['pytest.ini', '[pytest]\n'], ['calc.py', CALC], ['.gitignore', '__pycache__/\n.pytest_cache/\n.pullboard/junit/\n'], ['test_item.py', BASE_ITEM]]) writeFileSync(join(root, path), text);
}

/** A scratch board on the project: init'd, one lane owning it, the project committed on main, and one joined seat. */
export async function pytestBoard(helpers) {
  const box = pytestSandbox(helpers);
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  box.git(repo, 'config', 'user.name', 'Test Agent');
  box.git(repo, 'config', 'user.email', 'agent@example.com');
  writeProject(repo);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: the scratch project');
  const initialized = await box.runLocal(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.equal(String(config.gate?.command ?? config.gate), GATE, 'init recorded the detected gate');
  fixtureProjectPolicy(repo, {
    config: { ...config, verify: 'any', lanes: { web: { owns: ['pytest.ini', 'calc.py', 'test_item.py', '.gitignore'], specs: ['G1'] } }, landing: { ...(config.landing ?? {}), perItem: false, manualOverride: true, splitRed: false } },
    spec: '# Scratch spec\n\n## G · Goals\n- G1 [approved, must] The project adds. | gate: pytest\n',
  });
  box.git(repo, 'add', '-A');
  const configured = box.tryGit(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  assert.equal(configured.status, 0, configured.stderr);
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(repo, 'remote', 'add', 'origin', remote);
  assert.equal(box.tryGit(repo, 'push', '-q', '-u', 'origin', 'main').status, 0);
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const joined = await joinFixtureSeat(box, web, 'web', { run: box.runLocal });
  assert.equal(joined.code, 0, joined.err);
  Object.assign(box, { repo, web });
  return { box, repo, web };
}

/** File and claim one item in the seat, then commit a new item test and try to submit it; returns the item id, commit and submit result. */
export async function buildAndSubmit(board, id, itemText, priorReds = 0) {
  const { box, repo, web } = board;
  const item = id ?? String((await fileFixtureItem(box, repo, { lane: 'web', title: 'Add numbers', brief: BRIEF, check: CHECK, args: ['--specs', 'G1'], run: box.runLocal })).item_id);
  if (!id) assert.equal((await box.runLocal(web, 'claim', item)).code, 0);
  writeFileSync(join(web, 'test_item.py'), itemText);
  box.git(web, 'add', '-A');
  const committed = box.tryGit(web, 'commit', '-q', '-m', `feat(web): test adding numbers [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = await box.runIn(web, 'submit', item, '--no-next');
  // The pulled gate may still be running when submit returns: read the item until it is red again or has left the building state.
  const reds = text => (text.match(/Gate job \S+ red at/gu) ?? []).length;
  const read = async () => {
    const shown = await box.runIn(web, 'show', item, '--no-next');
    const status = JSON.parse((await box.runIn(web, 'show', item, '--json', '--no-next')).out).item_status;
    return status !== 'claimed' || reds(shown.out) > priorReds ? { shown, status } : null;
  };
  const { shown, status } = await whenRunnerSettles(box.env, read, { deadlineMs: 150_000, what: `the gate of item ${item}` });
  return { item, reds: reds(shown.out), commit: box.git(web, 'rev-parse', 'HEAD'), submitted, shown, status, text: `${submitted.out}\n${submitted.err}\n${shown.out}\n${shown.err}` };
}

/** Accept the submitted item as the coordinator at its commit, then land it; returns the settled landing. */
export async function acceptAndLand(board, item, commit) {
  const { box, repo } = board;
  box.git(repo, 'switch', '-q', '--detach', commit);
  try {
    const verdict = await verifySettled(box, box.runLocal, repo, ['verify', item, 'accept', '--as', 'coordinator', '--note', 'scratch project gate is green']);
    assert.equal(verdict.code, 0, verdict.err);
  } finally { box.git(repo, 'switch', '-q', 'main'); }
  const landing = await box.runIn(repo, 'land', '--json');
  return { landing, settled: await settleLand(box, JSON.parse(landing.out)) };
}
