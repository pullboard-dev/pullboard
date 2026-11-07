/** Keep CLI-created test items and seats valid as add and join rules evolve [C7]. */
import assert from 'node:assert/strict';
import { fixtureAdd, fixtureJoin } from './testkit-fixture.js';

/** Normalize the two child-process result shapes used by CLI-backed fixtures. */
function fixtureResult(result) {
  return { code: result.code ?? result.status, out: result.out ?? result.stdout ?? '', err: result.err ?? result.stderr ?? '' };
}

/** Join a fixture worktree with the model and route required by current admission rules. */
export function joinFixtureSeat(box, root, lane, { model = 'Fixture Model', route = 'strong', run = box.run } = {}) {
  return fixtureResult(fixtureJoin(run, root,  lane, '--model', model, '--route', route, '--json'));
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
  return fixtureAdd(run, cwd,  ...args);
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
  return fixtureJoin(run, cwd,  ...args);
}

/** The argv head for a spawned `pullboard add`: the CLI path then the verb, so spawned adds share the kit seam. */
export function fixtureAddArgv(cli) {
  return [cli, 'add'];
}

/** The argv head for a spawned `pullboard join`: the CLI path then the verb, so spawned joins share the kit seam. */
export function fixtureJoinArgv(cli) {
  return [cli, 'join'];
}
