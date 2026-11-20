/** @pullboard-test-input apps/cli/src/io/commands/block.js apps/cli/tests/fixtures/e2e.js apps/cli/tests/fixtures/next/take.js */
/** pullboard block add names a block of items and block list prints it as one row; a one-id or wrong-tier add is refused USAGE [C7,#2202]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fileFixtureItem } from '../../../../../packages/gate/tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('cli.block.add-and-list: clause 1: block add web-batch <id1> <id2> --tier mid prints the block, and block list prints one row web-batch mid #<id1> #<id2> [C7,#2202]', async () => {
  const box = e2e.project();
  const { item_id: first } = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'First block member', criterion: 'the first page exists', check: 'test -f web/first.js', wait: true, run: box.runLocal });
  const { item_id: second } = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Second block member', criterion: 'the second page exists', check: 'test -f web/second.js', wait: true, run: box.runLocal });
  const added = await box.runLocal(box.repo, 'block', 'add', 'web-batch', String(first), String(second), '--tier', 'mid');
  assert.equal(added.code, 0, added.err || added.out);
  assert.ok(added.out.includes(`web-batch mid #${first} #${second}`), added.out);
  const listed = await box.runLocal(box.repo, 'block', 'list');
  assert.equal(listed.code, 0, listed.err || listed.out);
  assert.equal(listed.out.split('\n')[0], `web-batch mid #${first} #${second}`);
  const json = await box.runLocal(box.repo, 'block', 'list', '--json');
  assert.equal(json.code, 0, json.err || json.out);
  assert.deepEqual(JSON.parse(json.out).blocks.map(block => ({ name: block.name, tier: block.tier, ids: block.ids })), [{ name: 'web-batch', tier: 'mid', ids: [first, second] }]);
});

test('cli.block.refusals: clause 2: block add with one id or --tier gpt refuses USAGE naming light, mid and strong [C7,#2202]', async () => {
  const box = e2e.project();
  const { item_id: first } = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Lone block member', criterion: 'the lone page exists', check: 'test -f web/lone.js', wait: true, run: box.runLocal });
  const { item_id: second } = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Other block member', criterion: 'the other page exists', check: 'test -f web/other.js', wait: true, run: box.runLocal });
  const lone = await box.runLocal(box.repo, 'block', 'add', 'solo', String(first), '--tier', 'mid');
  assert.notEqual(lone.code, 0, 'a block of one item is refused');
  assert.match(lone.err + lone.out, /USAGE/u);
  assert.match(lone.err + lone.out, /two or more/u);
  const wrong = await box.runLocal(box.repo, 'block', 'add', 'pair', String(first), String(second), '--tier', 'gpt');
  assert.notEqual(wrong.code, 0, 'a tier outside the three is refused');
  assert.match(wrong.err + wrong.out, /USAGE/u);
  for (const tier of ['light', 'mid', 'strong']) assert.ok((wrong.err + wrong.out).includes(tier), `the refusal names ${tier}`);
  const listed = await box.runLocal(box.repo, 'block', 'list');
  assert.match(listed.out, /no blocks/u, 'a refused add records nothing');
});

test('cli.block.claim: clause 1: block claim <name> claims every member for this seat and prints them, and a second seat block claim of the same block is refused BLOCK_CLAIMED [C7,#2202]', async t => {
  const box = await fixture(t, { route: 'strong' });
  const ids = [box.add('First claimed member'), box.add('Second claimed member')];
  store.addBlock(box.board, { agentId: 'coordinator', name: 'pair', ids, tier: 'mid' });
  const claimed = await cli(box, box.seats.actor.path, ['block', 'claim', 'pair']);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  assert.deepEqual(claimed.document.claimed, ids);
  for (const id of ids) assert.equal(store.getItem(box.board, id).item_owner, box.seats.actor.id, `the seat holds #${id}`);
  const refused = await cli(box, box.seats.builder.path, ['block', 'claim', 'pair']);
  assert.notEqual(refused.code, 0, 'a second seat cannot take a held block');
  assert.match(refused.out + refused.err, /BLOCK_CLAIMED/u);
});
