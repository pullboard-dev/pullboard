/** Shared scratch-project board for the PHP journeys: php and composer lookup, a composer project board with one seat, build-and-submit and accept-and-land [C7,#10618]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { settleLand } from '../land/settle.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import { verifySettled } from '../submit/settle.js';
import { joinFixtureSeat } from '../testkit.js';
import { fileFixtureItem } from '../testkit.js';
import { fixtureProjectPolicy } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../../../../packages/gate/tests/fixtures/testkit.js';

/** The account's own composer cache: a runner job's fresh HOME would download phpunit again on every gate. */
const REAL_COMPOSER_CACHE = join(userInfo().homedir || homedir(), 'Library', 'Caches', 'composer');

/**
 * The php folder and composer binary, or null when this machine lacks either.
 * Why: a runner job's PATH may lack their folders and its fresh HOME starts an empty composer cache, so a composer wrapper on PATH carries the account's cache [#10618].
 */
function composerEnvironment() {
  const found = {};
  for (const tool of ['php', 'composer']) {
    const probe = spawnSync(tool, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (probe.error || probe.status !== 0) return null;
    found[tool] = String(spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8', timeout: 5000 }).stdout).trim();
    if (!found[tool].startsWith('/')) return null;
  }
  return { php: dirname(found.php), composer: found.composer };
}

/** Single-quote one shell word. */
const quoted = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

/**
 * Write an executable wrapper named after the tool into the sandbox and return its folder.
 * Why: a gate job keeps only PATH from the sandbox's variables, so the wrapper carries the variables the tool needs [#10618].
 */
function wrapperFolder(box, name, variables, target, args = '') {
  const folder = join(box.dir, 'toolchain-bin');
  mkdirSync(folder, { recursive: true });
  const assignments = Object.entries(variables).map(([key, value]) => `${key}=${quoted(value)}`).join(' ');
  writeFileSync(join(folder, name), `#!/bin/sh\n${assignments} exec ${quoted(target)}${args} "$@"\n`, { mode: 0o755 });
  return folder;
}

export const COMPOSER = composerEnvironment();
export const UNAVAILABLE = 'php and composer unavailable on this machine';
export const GATE = 'composer test';

const BRIEF = 'Files:\n- tests/ItemTest.php\nChange:\n- Add the item test.\nTest:\n- composer test passes.';
/** An item check that fails on main and passes once the item's test is committed; it avoids the test name, so only the gate output can name it. */
const CHECK = "grep -q 'add(1, 2)' tests/ItemTest.php";
/** The test script installs phpunit from the lock first: the gate's fresh checkout holds no vendor folder. */
const COMPOSER_JSON = `${JSON.stringify({ name: 'scratch/calc', 'require': { php: '>=8.1' }, 'require-dev': { 'phpunit/phpunit': '*' }, scripts: { test: ['@composer install --no-interaction --no-progress --quiet', 'phpunit tests'] } }, null, 2)}\n`;
const CALC = '<?php\n\nfinal class Calc\n{\n    public static function add(int $a, int $b): int\n    {\n        return $a + $b;\n    }\n}\n';
const HEADER = '<?php\n\nrequire_once __DIR__ . \'/../src/Calc.php\';\n\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class ItemTest extends TestCase\n{\n';
export const PASSING = `${HEADER}    public function testAddsSmallNumbers(): void\n    {\n        $this->assertSame(3, Calc::add(1, 2));\n    }\n}\n`;
export const BROKEN = `${HEADER}    public function testAddsSmallNumbers(): void\n    {\n        $this->assertSame(4, Calc::add(1, 2));\n    }\n}\n`;
const BASE_ITEM = `${HEADER}    public function testAddsNothing(): void\n    {\n        $this->assertSame(0, Calc::add(0, 0));\n    }\n}\n`;

/**
 * A sandbox whose gate and runner see php, and find composer through a wrapper that reuses the account's composer cache and one vendor folder
 * for every checkout of the board, as the Rust journeys share one cargo target folder: set before the first command starts the runner.
 */
export function composerSandbox(helpers, settings = {}) {
  const box = helpers.sandbox();
  if (COMPOSER) box.env.PATH = [wrapperFolder(box, 'composer', { COMPOSER_CACHE_DIR: REAL_COMPOSER_CACHE, COMPOSER_NO_AUDIT: '1', COMPOSER_VENDOR_DIR: join(box.dir, 'vendor') }, COMPOSER.composer), COMPOSER.php, box.env.PATH].join(':');
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  return box;
}

/** Write the scratch composer project's files into a folder: composer.json is the PHP signal. */
export function writeProject(root) {
  const files = [['composer.json', COMPOSER_JSON], ['src/Calc.php', CALC], ['.gitignore', 'vendor/\n.phpunit.cache/\n.phpunit.result.cache\n.pullboard/junit/\n'], ['tests/ItemTest.php', BASE_ITEM]];
  for (const [path, text] of files) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A scratch board on the project: init'd, one lane owning it, the project committed on main, and one joined seat. */
export async function composerBoard(helpers) {
  const box = composerSandbox(helpers);
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  box.git(repo, 'config', 'user.name', 'Test Agent');
  box.git(repo, 'config', 'user.email', 'agent@example.com');
  writeProject(repo);
  // Lock phpunit once over the network, so each gate installs from the lock into the shared vendor folder without resolving again.
  const locked = spawnSync(join(box.dir, 'toolchain-bin', 'composer'), ['update', '--no-interaction', '--no-progress', '--quiet'], { cwd: repo, env: box.env, encoding: 'utf8', timeout: 150_000 });
  assert.equal(locked.status, 0, `composer update: ${locked.stderr}${locked.error ?? ''}`);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: the scratch project');
  const initialized = await box.runLocal(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.equal(String(config.gate?.command ?? config.gate), GATE, 'init recorded the detected gate');
  fixtureProjectPolicy(repo, {
    config: { ...config, verify: 'any', lanes: { web: { owns: ['composer.json', 'composer.lock', 'src/', 'tests/', '.gitignore'], specs: ['G1'] } }, landing: { ...(config.landing ?? {}), perItem: false, manualOverride: true, splitRed: false } },
    spec: '# Scratch spec\n\n## G · Goals\n- G1 [approved, must] The project adds. | gate: composer test\n',
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
  writeFileSync(join(web, 'tests', 'ItemTest.php'), itemText);
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
