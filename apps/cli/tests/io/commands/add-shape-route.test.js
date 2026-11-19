/** `add` with no --route picks the route from the item's shape, and an explicit --route still wins [C7,#3081]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { joinFixtureSeat } from '../../fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Add one item with `extra` arguments on a board that keeps the CLI's own default route; return the box and the filed item. */
async function addOn(extra) {
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_FIXTURE_ROUTES = 'board';
  const box = helpers.project('true', isolated);
  const added = await box.inProcess(box.repo, 'add', 'web', 'Small correction', '--specs', 'G1', '--json', ...extra);
  assert.equal(added.code, 0, added.err + added.out);
  return { box, item: JSON.parse(added.out).item };
}

/** Add one item with `extra` arguments and return its route. */
async function routeOf(extra) { return (await addOn(extra)).item.item_route; }

const small = ['--criterion', 'the handler returns the canonical result [test]', '--check', 'node --test web/handler.test.js', '--brief', 'Files: web/handler.js\nChange: fix\nTest: web/handler.test.js'];

test('cli.io-commands-add-shape-route.add-without-route-files-the-light-shape: clause 1: add without --route files the light shape as mid on a board that needs a diagnosis, and mid is how light is filed there [C7]', async () => {
  // A light add refuses DIAGNOSIS_REQUIRED on this board, so the light shape is filed mid until a seat diagnoses it.
  assert.equal(await routeOf(small), 'mid');
});

test('cli.io-commands-add-shape-route.add-without-route-sets-strong-when-the: clause 1: add without --route sets strong when the brief or the check is missing [C7]', async () => {
  assert.equal(await routeOf(['--criterion', 'the handler returns the canonical result [test]', '--check', 'npm test']), 'strong');
  assert.equal(await routeOf(['--criterion', 'the handler returns the canonical result [test]', '--brief', 'Files: web/handler.js']), 'strong');
});

test('cli.io-commands-add-shape-route.an-explicit-route-wins-over-the-shape: clause 1: an explicit --route wins over the shape rule [C7]', async () => {
  assert.equal(await routeOf([...small, '--route', 'strong']), 'strong');
  assert.equal(await routeOf([...small, '--route', 'mid']), 'mid');
});

test('cli.io-commands-add-shape-route.a-seat-claiming-the-item-add-filed: clause 2: a seat claiming the item add filed for the light shape is not refused DIAGNOSIS_REQUIRED [C7]', async () => {
  const { box, item } = await addOn(small);
  const seat = join(box.dir, 'web-seat');
  box.git(box.repo, 'worktree', 'add', '-q', seat, '-b', 'web/shape-route');
  assert.equal((await joinFixtureSeat(box, seat, 'web')).code, 0, 'the seat joins');
  const claimed = await box.runLocal(seat, 'claim', String(item.item_id), '--json');
  const said = `${claimed.out ?? claimed.stdout ?? ''}${claimed.err ?? claimed.stderr ?? ''}`;
  assert.doesNotMatch(said, /DIAGNOSIS_REQUIRED/u, 'the claim is not asking for a diagnosis');
  assert.equal(claimed.code ?? claimed.status, 0, said);
});
