/** Only the person grants a size override: --force-size by the coordinator is refused, the person's still files [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const ARGS = ['web', 'Oversized scope', '--criterion', 'the handler returns the canonical result [test]', '--check', 'npm test', '--force-size', 'these pieces must land together', '--json'];

test('clause 1: add --force-size by the coordinator is refused ITEM_FORCE_SIZE_PERSON with a next step to split [C7]', async t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const refused = await fixtureAdd(box.runLocal, box.repo, ...ARGS);
  assert.notEqual(refused.code, 0, refused.out);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'ITEM_FORCE_SIZE_PERSON');
  assert.match(error.next, /--after/u);
});

test('clause 2: the same call as the person still files an oversized item [C7]', async t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, ...ARGS, '--as', 'person');
  assert.equal(added.code, 0, added.err + added.out);
  assert.ok(JSON.parse(added.out).item.item_id);
});
