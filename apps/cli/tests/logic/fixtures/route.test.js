/** A bare fixture add files a strong item, so the board's mid rules never refuse fixture boards [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureAddRoute } from '../../fixtures/testkit.js';

test('cli.logic-fixtures-route.a-bare-fixture-add-gets-the-strong: a bare fixture add gets the strong route [C7]', () => {
  assert.deepEqual(fixtureAddRoute(['add', 'web', 'Title', '--criterion', 'x']), ['add', 'web', 'Title', '--criterion', 'x', '--route', 'strong']);
});

test('cli.logic-fixtures-route.an-add-naming-a-route-keeps-its: an add naming a route keeps its exact arguments [C7]', () => {
  assert.deepEqual(fixtureAddRoute(['add', 'web', 'T', '--route', 'mid']), ['add', 'web', 'T', '--route', 'mid']);
  assert.deepEqual(fixtureAddRoute(['add', 'web', 'T', '--route=light']), ['add', 'web', 'T', '--route=light']);
});

test('cli.logic-fixtures-route.other-commands-are-untouched: other commands are untouched [C7]', () => {
  assert.deepEqual(fixtureAddRoute(['claim', '3']), ['claim', '3']);
  assert.deepEqual(fixtureAddRoute(['lane', 'add', 'web']), ['lane', 'add', 'web']);
});
