/** `add` with no --route picks the route from the item's shape, and an explicit --route still wins [C7,#3081]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Add one item with `extra` arguments on a board that keeps the CLI's own default route; return its route. */
async function routeOf(extra) {
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_FIXTURE_ROUTES = 'board';
  const box = helpers.project('true', isolated);
  const added = await box.inProcess(box.repo, 'add', 'web', 'Small correction', '--specs', 'G1', '--json', ...extra);
  assert.equal(added.code, 0, added.err + added.out);
  return JSON.parse(added.out).item.item_route;
}

const small = ['--criterion', 'the handler returns the canonical result [test]', '--check', 'node --test web/handler.test.js', '--brief', 'Files: web/handler.js\nChange: fix\nTest: web/handler.test.js'];

test('clause 1: add without --route files the light shape as mid on a board that needs a diagnosis, and mid is how light is filed there [C7]', async () => {
  // A light add refuses DIAGNOSIS_REQUIRED on this board, so the light shape is filed mid until a seat diagnoses it.
  assert.equal(await routeOf(small), 'mid');
});

test('clause 1: add without --route sets strong when the brief or the check is missing [C7]', async () => {
  assert.equal(await routeOf(['--criterion', 'the handler returns the canonical result [test]', '--check', 'npm test']), 'strong');
  assert.equal(await routeOf(['--criterion', 'the handler returns the canonical result [test]', '--brief', 'Files: web/handler.js']), 'strong');
});

test('clause 1: an explicit --route wins over the shape rule [C7]', async () => {
  assert.equal(await routeOf([...small, '--route', 'strong']), 'strong');
  assert.equal(await routeOf([...small, '--route', 'mid']), 'mid');
});
