/** Seats registering as OpenAI and openai, or Claude and anthropic, share one family when review.canonicalFamilies is on [C7,#9681]. @pullboard-test-input source-cell apps/cli packages/config packages/items */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { crossLaneFixture } from '../../../fixtures/e2e.js';

/** The model name the fixture seats register with. */
const FIXTURE_MODEL = ['fixture', 'family'].join('-');

/** Join one fresh worktree seat with a family label and return the family the board stored for it. */
async function joinWith(box, name, family) {
  const seat = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', seat, 'main');
  const joined = box.json(await box.runAsLocal(`session-${name}`, seat, 'join', 'web', '--family', family,
    '--parent', `parent-${name}`, '--model', FIXTURE_MODEL, '--route', 'strong', '--json'));
  const agents = box.json(await box.runAsLocal(`session-${name}`, seat, 'status', '--json')).agents;
  return agents.find(agent => agent.agent_id === joined.agent).agent_family;
}

test('cli.journeys-queue-family-canonical.with-review-canonicalfamilies-on-openai-and: clause 1: with review.canonicalFamilies on, OpenAI and openai are one family and Claude and anthropic are one family [C7,#9681]', async t => {
  const box = crossLaneFixture(t);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...kept, review: { ...kept.review, canonicalFamilies: true } }));
  const labels = [['upper', 'OpenAI'], ['lower', 'openai'], ['claude', 'Claude'], ['vendor', 'anthropic']];
  const stored = {};
  for (const [name, label] of labels) stored[name] = await joinWith(box, name, label);
  assert.equal(stored.upper, stored.lower);
  assert.equal(stored.claude, stored.vendor);
  assert.notEqual(stored.upper, stored.claude);
  assert.equal(stored.upper, 'openai');
  assert.equal(stored.claude, 'anthropic');
});

test('cli.journeys-queue-family-canonical.with-review-canonicalfamilies-off-the-stored: clause 2: with review.canonicalFamilies off, the stored labels are read as typed [C7,#9681]', async t => {
  const box = crossLaneFixture(t);
  const upper = await joinWith(box, 'upper', 'OpenAI');
  const claude = await joinWith(box, 'claude', 'Claude');
  assert.equal(upper, 'OpenAI');
  assert.equal(claude, 'Claude');
});
