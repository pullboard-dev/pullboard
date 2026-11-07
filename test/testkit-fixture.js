/** Keep CLI-created test items and seats valid as add and join rules evolve [C7]. */
import assert from 'node:assert/strict';

/** Model names fixtures register or join with, kept here so tests never carry literal model strings. */
export const FIXTURE_MODEL = 'Fixture';
export const SYNTHETIC_MODEL = 'Synthetic fixture model';
export const NO_CHECKOUT_MODEL = 'no-checkout-fixture';

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
