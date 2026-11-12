/** A seat's route follows the model the session running in it declares, at next and at claim [B13]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project whose web-1 seat joined on the strong route with fixture-model, holding an older strong item and a mid one. */
function strongSeatWithWork() {
  const box = e2e.project('true');
  const strong = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Strong work', route: 'strong', diagnose: false });
  const mid = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Mid work', route: 'mid', diagnose: false });
  return { box, strong: strong.item_id, mid: mid.item_id };
}

/** Run one CLI command with this session declaring the given model through PULLBOARD_MODEL. */
async function declaring(box, model, ...args) {
  const before = box.env.PULLBOARD_MODEL;
  box.env.PULLBOARD_MODEL = model;
  try { return await box.runLocal(box.web, ...args); }
  finally {
    if (before === undefined) delete box.env.PULLBOARD_MODEL;
    else box.env.PULLBOARD_MODEL = before;
  }
}

test('clause 1: a strong seat whose session declares a mid model is offered the mid item, never the strong one, through next [B13]', async () => {
  const { box, strong, mid } = strongSeatWithWork();
  const next = await declaring(box, 'claude-sonnet-5-5', 'next', '--json');
  assert.equal(next.code, 0, next.out + next.err);
  const offered = JSON.parse(next.out);
  assert.equal(offered.item?.item_id ?? offered.id, mid, `next must offer the mid item, not strong #${strong}: ${next.out}`);
  const whoami = JSON.parse((await declaring(box, 'claude-sonnet-5-5', 'whoami', '--json')).out);
  assert.equal(whoami.route, 'mid', 'the caller route is the declared model\'s route');
});

test('clause 1: a strong seat whose session declares a light model cannot claim the strong or the mid item [B13]', async () => {
  const { box, strong, mid } = strongSeatWithWork();
  for (const id of [strong, mid]) {
    const claim = await declaring(box, 'claude-haiku-6-0', 'claim', String(id), '--json');
    assert.notEqual(claim.code, 0, `a light model must not claim #${id}: ${claim.out}`);
    assert.equal(JSON.parse(claim.out).error.code, 'ROUTE', claim.out);
    assert.match(claim.out, /the model this session declared serves the light route/u);
  }
  const idle = await declaring(box, 'claude-haiku-6-0', 'next', '--json');
  assert.doesNotMatch(idle.out, new RegExp(`"item_id":\\s*(${strong}|${mid})\\b`, 'u'), 'next offers a light session neither item');
});

test('clause 2: the same seat with a strong model declared again claims the strong item, with no rejoin [B13]', async () => {
  const { box, strong } = strongSeatWithWork();
  const refused = await declaring(box, 'claude-haiku-6-0', 'claim', String(strong), '--json');
  assert.equal(JSON.parse(refused.out).error.code, 'ROUTE', refused.out);
  const strongAgain = await declaring(box, 'claude-opus-5-5', 'next', '--json');
  assert.equal(strongAgain.code, 0, strongAgain.out + strongAgain.err);
  const offered = JSON.parse(strongAgain.out);
  assert.equal(offered.item?.item_id ?? offered.id, strong, `a strong model is offered the strong item again: ${strongAgain.out}`);
  const joinedModel = await declaring(box, 'fixture-model', 'whoami', '--json');
  assert.equal(JSON.parse(joinedModel.out).route, 'strong', 'the joined model keeps the joined route');
});
