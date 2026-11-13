/** A forced landing with no recorded builder takes the builder's family from its claim events, so verify.family require still judges it [V1,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

/** A seat in its own worktree and session, so no seat inherits another's declared family. */
async function seat(box, name, args) {
  const root = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, 'main');
  const joined = await box.runAsLocal(`${name}-session`, root, 'join', 'web', ...args, '--route', 'strong', '--json');
  assert.equal(joined.code, 0, joined.out + joined.err);
  return root;
}

/** An item claimed by a seat that declared no family but named its model, then landed by hand around the gate once verify.family is require. */
async function fixture(t, model) {
  const box = crossLaneFixture(t);
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Claimed then hand landed', criterion: 'the result exists', check: 'test -f web/result.txt', run: box.runLocal });
  const builder = await seat(box, 'builder', ['--model', model]);
  const claimed = await box.runAsLocal('builder-session', builder, 'claim', String(item.item_id));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  // The claim predates the policy, as the old landings do: a family-requiring board would refuse a claim with no declared family.
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, verify: { ...config.verify, family: 'require' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: require a different review family');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/result.txt'), 'hand landed\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'feat(web): land the result by hand [G1]');
  const landing = box.git(box.repo, 'rev-parse', 'HEAD');
  const merged = await box.runLocal(box.repo, 'merged', String(item.item_id), landing, '--forced', 'hand landed around the gate');
  assert.equal(merged.code, 0, merged.out + merged.err);
  return { box, id: item.item_id };
}

/** The models the claimer and the two reviewers declare; only the claimer's is mapped to a family by the board. */
const CLAIMER_MODEL = 'Sonnet 5.5', OPENAI_MODEL = 'gpt-6.1-sol', ANTHROPIC_MODEL = 'Opus 5.5';
const NOTE = 'Read the hand landing and ran its frozen check; the file exists.';

test('clause 1: a reviewer of another family than the claimer\'s model is admitted [V1,H16]', async t => {
  const { box, id } = await fixture(t, CLAIMER_MODEL);
  const reviewer = await seat(box, 'openai-reviewer', ['--family', 'openai', '--model', OPENAI_MODEL]);
  const accepted = await box.runAsLocal('openai-reviewer-session', reviewer, 'verify', String(id), 'accept', '--note', NOTE);
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
});

test('clause 1: a reviewer of the claimer\'s model family is refused O2_FAMILY_MATCH [V1,H16]', async t => {
  const { box, id } = await fixture(t, CLAIMER_MODEL);
  const reviewer = await seat(box, 'anthropic-reviewer', ['--family', 'anthropic', '--model', ANTHROPIC_MODEL]);
  const refused = await box.runAsLocal('anthropic-reviewer-session', reviewer, 'verify', String(id), 'accept', '--note', NOTE);
  assert.notEqual(refused.code, 0, refused.out + refused.err);
  assert.match(refused.out + refused.err, /O2_FAMILY_MATCH/u);
});
