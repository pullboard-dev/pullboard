/** Keep CLI-created test items and seats valid as add and join rules evolve [C7]. */
import assert from 'node:assert/strict';

/** Join a fixture worktree with the model and route required by current admission rules. */
export function joinFixtureSeat(box, root, lane, { model = 'Fixture Model', route = 'strong', run = box.run } = {}) {
  return run(root, 'join', lane, '--model', model, '--route', route, '--json');
}

/** Add a fixture item with a complete route-specific build brief and return its parsed item. */
export function fileFixtureItem(box, root, { lane, title, criterion = 'The fixture item is valid.', check = 'true', route = 'strong', brief, args = [], run = box.run } = {}) {
  const buildBrief = brief ?? `Files:\n- ${lane}/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- ${title} passes.`;
  const result = run(root, 'add', lane, title, '--route', route, '--criterion', criterion, '--check', check, '--brief', buildBrief, ...args, '--json');
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return JSON.parse(result.out).item;
}
