/** @pullboard-test-input apps/cli/src/io/commands/join.js */
/** join --json carries level beside route, equal to it, on a new registration and on an already-joined seat [C7,#10969]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { joinFixtureSeat } from '../../../fixtures/testkit.js';
import { withoutRoute } from '../../../fixtures/join-seat.js';

/** A light-tier model name: the fixture join adds no route for it, so a repeated join names none. */
const LIGHT_MODEL = 'Fixture Haiku';
const e2e = createE2eHelpers();
after(e2e.cleanup);
/** The one fixture project this file's case builds its seat in. */
let box;
before(() => { box = e2e.project(); });

test('cli.io-commands-join-level.join-json-carries-level-beside-route: clause 1: join --json carries level equal to route, route kept as an alias, on both result paths [C7,#10969]', async () => {
  const seat = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', seat, '-b', 'web/two');
  const registered = joinFixtureSeat(box, seat, 'web', { model: LIGHT_MODEL, route: 'light' });
  assert.equal(registered.code, 0, registered.err);
  const fresh = JSON.parse(registered.out);
  assert.equal(fresh.route, 'light');
  assert.equal(fresh.level, fresh.route);
  const repeated = await joinFixtureSeat(box, seat, 'web', { model: LIGHT_MODEL, run: withoutRoute(box) });
  assert.equal(repeated.code, 0, repeated.err);
  const already = JSON.parse(repeated.out);
  assert.equal(already.alreadyJoined, true);
  assert.equal(already.route, 'light');
  assert.equal(already.level, already.route);
});
