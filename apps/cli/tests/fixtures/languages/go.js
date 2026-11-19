/** Shared scratch-module board for the Go journeys: go lookup, a module board with one seat, build-and-submit and accept-and-land [C7,#10612]. */
import assert from 'node:assert/strict';
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

/** The account's real home: a runner job's fresh HOME holds an empty go build cache, so every gate would rebuild the standard library. */
const REAL_HOME = userInfo().homedir || homedir();

/**
 * The go binary and the account's build cache, or null when this machine has no working go.
 * Why: a runner job's PATH may lack go's folder and its fresh HOME starts a cold build cache; a wrapper on PATH carries both [#10612].
 */
function goEnvironment() {
  const probe = spawnSync('go', ['env', 'GOCACHE'], { env: { ...process.env, HOME: REAL_HOME }, encoding: 'utf8', timeout: 10_000 });
  if (probe.error || probe.status !== 0) return null;
  const go = String(spawnSync('sh', ['-c', 'command -v go'], { encoding: 'utf8', timeout: 5000 }).stdout).trim();
  const cache = String(probe.stdout).trim();
  return go.startsWith('/') && cache.startsWith('/') ? { go, cache } : null;
}

/** Single-quote one shell word. */
const quoted = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

/**
 * Write an executable wrapper named after the tool into the sandbox and return its folder.
 * Why: a gate job keeps only PATH from the sandbox's variables, so the wrapper carries the variables the tool needs [#10612].
 */
function wrapperFolder(box, name, variables, target, args = '') {
  const folder = join(box.dir, 'toolchain-bin');
  mkdirSync(folder, { recursive: true });
  const assignments = Object.entries(variables).map(([key, value]) => `${key}=${quoted(value)}`).join(' ');
  writeFileSync(join(folder, name), `#!/bin/sh\n${assignments} exec ${quoted(target)}${args} "$@"\n`, { mode: 0o755 });
  return folder;
}

export const GO = goEnvironment();
export const UNAVAILABLE = 'go unavailable on this machine';
export const GATE = 'go test ./...';

const BRIEF = 'Files:\n- item_test.go\nChange:\n- Add the item test.\nTest:\n- go test ./... passes.';
/** An item check that fails on main and passes once the item's test is committed; it avoids the test name, so only the gate output can name it. */
const CHECK = "grep -q 'Add(1, 2)' item_test.go";
const MODULE = 'module example.com/calc\n\ngo 1.21\n';
const CALC = 'package calc\n\n// Add returns the sum of a and b.\nfunc Add(a, b int) int {\n\treturn a + b\n}\n';
const HEADER = 'package calc\n\nimport "testing"\n\n';
export const PASSING = `${HEADER}func TestAddsSmallNumbers(t *testing.T) {\n\tif got := Add(1, 2); got != 3 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n`;
export const BROKEN = `${HEADER}func TestAddsSmallNumbers(t *testing.T) {\n\tif got := Add(1, 2); got != 4 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n`;
const BASE_ITEM = `${HEADER}func TestAddsNothing(t *testing.T) {\n\tif got := Add(0, 0); got != 0 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n`;

/** A sandbox whose gate and runner find go through a wrapper that keeps a warm build cache and never fetches a newer toolchain: set before the first command starts the runner. */
export function goSandbox(helpers, settings = {}) {
  const box = helpers.sandbox();
  if (GO) box.env.PATH = [wrapperFolder(box, 'go', { GOCACHE: GO.cache, GOTOOLCHAIN: 'local' }, GO.go), box.env.PATH].join(':');
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  return box;
}

/** Write the scratch module's files into a folder: go.mod is the Go signal. */
export function writeProject(root) {
  for (const [path, text] of [['go.mod', MODULE], ['calc.go', CALC], ['.gitignore', '.pullboard/junit/\n'], ['item_test.go', BASE_ITEM]]) writeFileSync(join(root, path), text);
}

/** A scratch board on the module: init'd, one lane owning it, the module committed on main, and one joined seat. */
export async function goBoard(helpers) {
  const box = goSandbox(helpers);
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  box.git(repo, 'config', 'user.name', 'Test Agent');
  box.git(repo, 'config', 'user.email', 'agent@example.com');
  writeProject(repo);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: the scratch module');
  const initialized = await box.runLocal(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.equal(String(config.gate?.command ?? config.gate), GATE, 'init recorded the detected gate');
  fixtureProjectPolicy(repo, {
    config: { ...config, verify: 'any', lanes: { web: { owns: ['go.mod', 'calc.go', 'item_test.go', '.gitignore'], specs: ['G1'] } }, landing: { ...(config.landing ?? {}), perItem: false, manualOverride: true, splitRed: false } },
    spec: '# Scratch spec\n\n## G · Goals\n- G1 [approved, must] The module adds. | gate: go test ./...\n',
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
  writeFileSync(join(web, 'item_test.go'), itemText);
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
