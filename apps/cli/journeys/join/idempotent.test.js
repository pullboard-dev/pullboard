/** A same-seat, same-lane and same-model join is harmless to repeat [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  test,
  after,
} from 'node:test';
import { join } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Join a fixture seat once and return the box and its worktree. */
function joinedSeat() {
  const box = e2e.project('true', undefined, { withWorktree: false });
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // The board's model table determines the original route since b95e1aa538.
  config.modelTiers = [{ contains: 'Fixture', route: 'strong' }];
  writeFileSync(configPath, JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-qm', 'chore: route join fixture');
  const worktree = join(box.dir, 'joined-seat');
  box.git(box.repo, 'worktree', 'add', '-q', worktree, '-b', 'web/join-idempotent');
  const first = fixtureJoin(box.run, worktree, 'web', '--model', 'Fixture');
  assert.equal(first.code, 0, first.err);
  return { box, worktree };
}

test('clause 1: rejoining the same lane and model exits 0 and points to next [C7]', () => {
  const { box, worktree } = joinedSeat();
  const again = fixtureJoin(box.run, worktree, 'web', '--model', 'Fixture');
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already joined as web-1 \(Fixture\); run pullboard next/u);
  assert.equal(JSON.parse(fixtureJoin(box.run, worktree, 'web', '--model', 'Fixture', '--json').out).agent, 'web-1');

  const family = fixtureJoin(box.run, worktree, 'web', '--model', 'Fixture', '--family', 'OpenAI', '--json');
  assert.equal(family.code, 0, family.err);
  assert.equal(JSON.parse(family.out).family, 'OpenAI');
  const route = fixtureJoin(box.run, worktree, 'web', '--model', 'Fixture', '--route', 'light', '--json');
  assert.notEqual(route.code, 0, 'an incompatible explicit route must reach native registration and refuse');
  assert.equal(JSON.parse(route.out).error.code, 'ALREADY_JOINED');
  const updated = JSON.parse(box.run(worktree, 'whoami', '--json').out);
  assert.equal(updated.family, 'OpenAI', 'explicit family reaches the board');
  assert.equal(updated.route, 'strong', 'a refused explicit route preserves the registration');
  const familyAgain = fixtureJoin(box.run, worktree, 'web', '--model', 'Fixture', '--family', 'OpenAI', '--json');
  assert.equal(familyAgain.code, 0, familyAgain.err);
  assert.equal(JSON.parse(familyAgain.out).route, 'strong', 'a family-only update preserves the route');

});

test('clause 2: rejoining with a different lane or model still refuses [C7]', () => {
  const { box, worktree } = joinedSeat();
  const otherLane = fixtureJoin(box.run, worktree, 'api', '--model', 'Fixture');
  assert.notEqual(otherLane.code, 0);
  assert.match(otherLane.err, /ALREADY_JOINED/u);
  const otherModel = fixtureJoin(box.run, worktree, 'web', '--model', 'Another Fixture');
  assert.notEqual(otherModel.code, 0);
  assert.match(otherModel.err, /ALREADY_JOINED/u);
  assert.equal(JSON.parse(box.run(worktree, 'whoami', '--json').out).model, 'Fixture', 'a refused rejoin preserves the registered model');
});

test('the join CLI confirms the recorded family in its text and --json, on first join, without one, and on rejoin [C7]', () => {
  // Seats must declare a model; the fixture project's own join reads it from the runner's environment.
  process.env.PULLBOARD_MODEL ??= FIXTURE_MODEL;
  const box = e2e.project('true');
  const seat = name => {
    const dir = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', dir, '-b', `api/${name}`);
    return dir;
  };
  const none = seat('undeclared'), declared = seat('declared');
  const bare = fixtureJoin(box.run, none, 'api', '--model', FIXTURE_MODEL, '--json');
  assert.equal(bare.code, 0, bare.err);
  assert.equal(JSON.parse(bare.out).family, null);
  assert.doesNotMatch(fixtureJoin(box.run, none, 'api', '--model', FIXTURE_MODEL).out, /family/u);
  const first = fixtureJoin(box.run, declared, 'api', '--model', FIXTURE_MODEL, '--family', 'anthropic');
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /joined as .*\(family anthropic\) in the api lane/u);
  assert.equal(JSON.parse(fixtureJoin(box.run, declared, 'api', '--model', FIXTURE_MODEL, '--family', 'anthropic', '--json').out).family, 'anthropic');
  // A seat that joined bare, then rejoins naming a family: the response reports what is now recorded.
  const later = fixtureJoin(box.run, none, 'api', '--model', FIXTURE_MODEL, '--family', 'openai');
  assert.match(later.out, /\(family openai\)/u);
  assert.equal(JSON.parse(fixtureJoin(box.run, none, 'api', '--model', FIXTURE_MODEL, '--json').out).family, 'openai');
});
