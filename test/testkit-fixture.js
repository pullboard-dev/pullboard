/** Keep CLI-created test items and seats valid as add and join rules evolve [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeBoard, openBoard } from '../apps/lib/index.js';

/** Normalize the two child-process result shapes used by CLI-backed fixtures. */
function fixtureResult(result) {
  return { code: result.code ?? result.status, out: result.out ?? result.stdout ?? '', err: result.err ?? result.stderr ?? '' };
}

/** Join a fixture worktree with the model and route required by current admission rules. */
export function joinFixtureSeat(box, root, lane, { model = 'Fixture Model', route = 'strong', run = box.run } = {}) {
  return fixtureResult(run(root, 'join', lane, '--model', model, '--route', route, '--json'));
}

/** Add a fixture item with a complete route-specific build brief and return its parsed item; a diagnosis fact routes the item light, so pass diagnose: false to keep the declared route. */
export function fileFixtureItem(box, root, { lane, title, criterion = 'The fixture item is valid.', check = 'true', route = 'strong', brief, diagnosis, diagnose = true, args = [], wait = false, run = box.run } = {}) {
  const buildBrief = brief ?? `Files:\n- ${lane}/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- ${title} passes.`;
  const addArgs = ['add', lane, title, '--route', route, '--criterion', criterion];
  if (check !== null) addArgs.push('--check', check);
  addArgs.push('--brief', buildBrief, ...args, '--json');
  if (wait) addArgs.splice(addArgs.length - 1, 0, '--wait');
  const result = fixtureResult(run(root, ...addArgs));
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  const item = JSON.parse(result.out).item;
  if (check !== null && diagnose) {
    const recorded = fixtureResult(run(root, 'fact', String(item.item_id), 'diagnosis', diagnosis ?? buildBrief, '--json'));
    assert.equal(recorded.code, 0, `${recorded.out}\n${recorded.err}`);
  }
  return item;
}

/** Create and join a fixture worktree with all current admission identity flags. */
export function createFixtureWorktree(box, root, lane, { model = 'Fixture Model', route = 'strong', run = box.run } = {}) {
  return fixtureResult(run(root, 'worktree', lane, '--model', model, '--route', route, '--json'));
}

/**
 * Run a fixture `pullboard add` through the kit and return the runner's result untouched.
 *
 * Why: every test that files an item reaches the CLI through this one seam, so a new add rule is met here
 * once instead of in hundreds of copies. Tests that assert a refusal keep their exact arguments.
 *
 * @param {(cwd: string, ...args: string[]) => unknown} run - The fixture's CLI runner, such as box.run.
 * @param {string} cwd - The checkout the command runs in.
 * @param {...string} args - Everything after `add`: lane, title words and flags.
 * @returns {unknown} Whatever the runner returns, a promise included.
 */
export function fixtureAdd(run, cwd, ...args) {
  return run(cwd, 'add', ...args);
}

/**
 * Run a fixture `pullboard join` through the kit and return the runner's result untouched.
 *
 * Why: seat admission rules (model, route, family) change; one seam lets the kit meet them for every test.
 *
 * @param {(cwd: string, ...args: string[]) => unknown} run - The fixture's CLI runner, such as box.run.
 * @param {string} cwd - The worktree that joins.
 * @param {...string} args - Everything after `join`: lane and flags.
 * @returns {unknown} Whatever the runner returns, a promise included.
 */
export function fixtureJoin(run, cwd, ...args) {
  return run(cwd, 'join', ...args);
}

/** The argv head for a spawned `pullboard add`: the CLI path then the verb, so spawned adds share the kit seam. */
export function fixtureAddArgv(cli) {
  return [cli, 'add'];
}

/** The argv head for a spawned `pullboard join`: the CLI path then the verb, so spawned joins share the kit seam. */
export function fixtureJoinArgv(cli) {
  return [cli, 'join'];
}

/**
 * Merge policy fields into a fixture project's committed pullboard.json on main.
 *
 * Why: policy files are written once here, so a test declares only the fields it needs and a policy rule change is
 * met in one place.
 *
 * @param {object} box - The e2e project (repo, git).
 * @param {object} fields - Top-level pullboard.json fields to set, such as affectedTests or submitGate.
 * @returns {object} The committed config.
 */
export function fixturePolicy(box, fields) {
  const path = join(box.repo, 'pullboard.json');
  const config = { ...JSON.parse(readFileSync(path, 'utf8')), ...fields };
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure fixture policy [G1]');
  return config;
}

/**
 * Write a fixture project's policy files before its first commit, setting exactly the fields the test names.
 *
 * Why: the hand-policy check sends tests here instead of writing pullboard.json or SPEC.md by hand; unlike
 * fixtureHandoffPolicy it forces no gate and no hand-off, so a test keeps the policy it declares.
 *
 * @param {string} repo - The fixture repository root.
 * @param {{ config?: object, spec?: string }} policy - The pullboard.json object, and the SPEC.md text when the test needs one.
 * @returns {void}
 */
export function fixtureProjectPolicy(repo, { config = {}, spec } = {}) {
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(config));
  if (spec !== undefined) writeFileSync(join(repo, 'SPEC.md'), spec);
}

/**
 * Commit the native submit hand-off policy into a fixture project and bring its web checkout up to date.
 *
 * Why: policy files are written once here, so a policy rule change is met for every test.
 *
 * @param {object} box - The e2e project (repo, web, git).
 * @param {object} config - The base pullboard.json config the project was built with.
 * @returns {string} The board file inside the repository's .git, where the native CLI keeps it.
 */
export function fixtureHandoffPolicy(box, config) {
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, gate: 'true', submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return join(box.repo, '.git', 'pullboard', 'board.sqlite');
}

/**
 * Open a fixture project's board in process, bound to its web checkout.
 *
 * Why: in-process board reads go through the kit seam instead of opening the file by hand.
 *
 * @param {object} box - The e2e project (boardFile, web).
 * @returns {object} The open board; the caller closes board.db.
 */
export function fixtureOpenBoard(box) {
  return openBoard(box.boardFile, undefined, { gitRoot: box.web });
}

/**
 * Open a board file in process, hand it to the body, and close it after, even when the body throws.
 *
 * Why: tests that read or seed a board file they did not build as a project still go through the kit seam.
 *
 * @param {string} file - The board.sqlite path; a new file is created when it does not exist.
 * @param {(board: object) => any} body - Receives the open board; may return a promise.
 * @returns {Promise<any>|any} What the body returns.
 */
export function withFixtureBoard(file, body) {
  const board = openBoard(file);
  let result;
  try { result = body(board); }
  catch (error) { closeBoard(board); throw error; }
  if (result && typeof result.then === 'function') return Promise.resolve(result).finally(() => closeBoard(board));
  closeBoard(board);
  return result;
}
