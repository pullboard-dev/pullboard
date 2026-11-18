/** Shared scratch-project board for the TypeScript journey: a Node that strips types, an npm project board with one seat, build-and-submit and accept-and-land [C7,#10569]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
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

/**
 * The folder a gate needs to run npm and a type-stripping node, or null when this Node cannot run .ts files or has no npm beside it.
 * Why: the gate runs npm test in a job whose PATH may lack this Node's folder, so the sandbox adds it [#10569].
 */
function typescriptEnvironment() {
  if (!process.features?.typescript) return null;
  const folder = dirname(process.execPath);
  const npm = spawnSync(join(folder, 'npm'), ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return npm.error || npm.status !== 0 ? null : { folders: [folder] };
}

export const TYPESCRIPT = typescriptEnvironment();
export const UNAVAILABLE = 'a type-stripping node with npm unavailable on this machine';
export const GATE = 'npm test';

const BRIEF = 'Files:\n- test/item.test.ts\nChange:\n- Add the item test.\nTest:\n- npm test passes.';
/** An item check that fails on main and passes once the item's test is committed; it avoids the test name, so only the gate output can name it. */
const CHECK = "grep -q 'add(1, 2)' test/item.test.ts";
const PACKAGE = `${JSON.stringify({ name: 'scratch-calc', version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test test/*.test.ts' } }, null, 2)}\n`;
const TSCONFIG = `${JSON.stringify({ compilerOptions: { module: 'nodenext', target: 'es2022', strict: true, noEmit: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true } }, null, 2)}\n`;
const CALC = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
const HEADER = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../src/calc.ts';\n\n";
export const PASSING = `${HEADER}test('adds_small_numbers', () => {\n  const sum: number = add(1, 2);\n  assert.equal(sum, 3);\n});\n`;
export const BROKEN = `${HEADER}test('adds_small_numbers', () => {\n  const sum: number = add(1, 2);\n  assert.equal(sum, 4);\n});\n`;
const BASE_ITEM = `${HEADER}test('adds_nothing', () => {\n  const sum: number = add(0, 0);\n  assert.equal(sum, 0);\n});\n`;

/** A sandbox whose gate and runner see npm and this Node, outside the parent test run's context: set before the first command starts the runner. */
export function typescriptSandbox(helpers, settings = {}) {
  const box = helpers.sandbox();
  box.env.PATH = [...(TYPESCRIPT?.folders ?? []), box.env.PATH].join(':');
  // The gate's own node --test must report as a top-level run, not as a child of this journey's run.
  delete box.env.NODE_TEST_CONTEXT;
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  return box;
}

/** Write the scratch TypeScript project's files into a folder. */
export function writeProject(root) {
  for (const [path, text] of [['package.json', PACKAGE], ['tsconfig.json', TSCONFIG], ['.gitignore', 'node_modules/\n.pullboard/junit/\n'], ['src/calc.ts', CALC], ['test/item.test.ts', BASE_ITEM]]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A scratch board on the project: init'd, one lane owning it, the project committed on main, and one joined seat. */
export async function typescriptBoard(helpers) {
  const box = typescriptSandbox(helpers);
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
    config: { ...config, verify: 'any', lanes: { web: { owns: ['src/', 'test/', 'package.json', 'tsconfig.json', '.gitignore'], specs: ['G1'] } }, landing: { ...(config.landing ?? {}), perItem: false, manualOverride: true, splitRed: false } },
    spec: '# Scratch spec\n\n## G · Goals\n- G1 [approved, must] The project adds. | gate: npm test\n',
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
  writeFileSync(join(web, 'test/item.test.ts'), itemText);
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
