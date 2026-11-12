/** pullboard add and edit never silently drop a repeated single-value flag [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import * as store from '../../../../packages/store/index.js';

test('clause 1: add and edit refuse a repeated --criterion with a code that names the flag, and change nothing [C7]', async t => {
  const box = await fixture(t);
  const before = store.listItems(box.board, { all: true }).length;
  const added = await cli(box, box.root, ['add', 'Two clause item', '--lane', 'web', '--criterion', 'First clause', '--criterion', 'Second clause', '--check', 'true', '--json']);
  assert.notEqual(added.code, 0, added.out + added.err);
  assert.match(added.out + added.err, /REPEATED_FLAG --criterion/u);
  assert.equal(JSON.parse(added.out).error.code, 'REPEATED_FLAG', 'the --json refusal code is REPEATED_FLAG, not USAGE');
  assert.equal(store.listItems(box.board, { all: true }).length, before, 'no item was filed with half its criterion');
  const id = box.add('Existing item');
  const criterion = store.getItem(box.board, id).item_criterion;
  const edited = await cli(box, box.root, ['edit', String(id), '--criterion', 'First clause', '--criterion', 'Second clause', '--json']);
  assert.notEqual(edited.code, 0, edited.out + edited.err);
  assert.match(edited.out + edited.err, /REPEATED_FLAG --criterion/u);
  assert.equal(JSON.parse(edited.out).error.code, 'REPEATED_FLAG', 'the --json refusal code is REPEATED_FLAG, not USAGE');
  assert.equal(store.getItem(box.board, id).item_criterion, criterion, 'the criterion is unchanged');
});

for (const flag of [
  // Every single-value text flag the add and edit readers consume (apps/cli/src/io/commands/add.js and edit.js, the textArg helper in cli/add.js).
  'title', 'brief', 'brief-file', 'note', 'note-file', 'lane', 'specs', 'check', 'route', 'parent', 'after', 'check-timing',
  'expected-minutes', 'force-size', 'review-family', 'reason', 'review-tier', 'machine-verified', 'machine-commands-file',
]) {
  test(`clause 2: add and edit refuse a repeated --${flag} and name it [C7]`, async t => {
    const box = await fixture(t);
    const id = box.add('Existing item');
    for (const args of [['add', 'Repeated flag item'], ['edit', String(id)]]) {
      const result = await cli(box, box.root, [...args, `--${flag}`, 'first value', `--${flag}=second value`, '--json']);
      assert.notEqual(result.code, 0, result.out + result.err);
      assert.match(result.out + result.err, new RegExp(`REPEATED_FLAG --${flag}`, 'u'), `${args[0]} names --${flag}`);
      assert.equal(JSON.parse(result.out).error.code, 'REPEATED_FLAG', `${args[0]} --${flag}: the --json refusal code is REPEATED_FLAG, not USAGE`);
    }
  });
}
