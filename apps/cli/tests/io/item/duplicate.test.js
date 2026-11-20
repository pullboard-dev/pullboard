/** pullboard add's duplicate guard reads the files a bar names: disjoint files are distinct work, shared or missing files stay refused [C7,#11843]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureAdd } from '../../fixtures/testkit.js';

const CHECK = 'node --test web/handler.test.js';

/** One real local board with the duplicate guard on, since a fixture board switches it off by default. */
function guardedBoard(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  box.env.PULLBOARD_FIXTURE_ADD_DISTINCT = '0';
  return { box, add: (title, criterion) => fixtureAdd(box.runLocal, box.repo, 'web', title, '--criterion', criterion, '--check', CHECK, '--json') };
}

/** A templated per-file bar: the same words, one module name. */
const bar = (file) => `1. ${file} exports a pad function that left-pads a string to a width, and its test covers empty input and wide input [test]`;

test('cli.io-item-duplicate.different-files-pass: clause 1: guardDuplicate returns null for a new item scoring 0.8 or more against an open item when both bars name file paths and they share none [C7,#11843]', async t => {
  const { add } = guardedBoard(t);
  const first = await add('Left pad utility', bar('web/pad-left.js'));
  assert.equal(first.code, 0, first.err + first.out);
  const second = await add('Left pad utility', bar('web/pad-right.js'));
  assert.equal(second.code, 0, second.err + second.out);
});

test('cli.io-item-duplicate.shared-file-refused: clause 2: a near open item that names a file the new item also names, or names no files at all, is still refused DUPLICATE_LIKELY [C7,#11843]', async t => {
  const { add } = guardedBoard(t);
  const first = await add('Left pad utility', bar('web/pad-left.js'));
  assert.equal(first.code, 0, first.err + first.out);
  const shared = await add('Left pad utility', bar('web/pad-left.js'));
  assert.equal(JSON.parse(shared.out).error.code, 'DUPLICATE_LIKELY');
  const unnamed = await add('Left pad utility', '1. the module exports a pad function that left-pads a string to a width, and its test covers empty input and wide input [test]');
  assert.equal(JSON.parse(unnamed.out).error.code, 'DUPLICATE_LIKELY');
});
