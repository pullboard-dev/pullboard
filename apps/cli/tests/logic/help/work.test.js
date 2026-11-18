/** The work and coordinator help name --level, not --route, for add, edit, list, request, brief and sweep [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coordinatorHelp } from '../../../src/logic/help/coordinator.js';
import { workHelp } from '../../../src/logic/help/work.js';

const line = (text, start) => text.split('\n').find(row => row.trimStart().startsWith(start)) ?? assert.fail(`no help line starting ${start}`);

test('cli.logic-help-work.add-and-edit-usage-show-level-not-route: clause 1: the add and edit usage lines show --level light|mid|strong and no --route [test] [C7]', () => {
  const edit = line(workHelp, 'pullboard edit <id>');
  assert.match(edit, /--level light\|mid\|strong/u);
  assert.doesNotMatch(edit, /--route/u);
  const addBlock = workHelp.slice(workHelp.indexOf('pullboard add <lane>'), workHelp.indexOf('pullboard edit <id>'));
  assert.match(addBlock, /--level light\|mid/u);
  assert.doesNotMatch(addBlock, /--route/u);
});

test('cli.logic-help-work.list-request-and-sweep-usage-show-level: clause 2: the list, request and brief lines and the sweep line name --level [test] [C7]', () => {
  assert.match(line(workHelp, 'pullboard list [lane]'), /--level light\|mid\|strong/u);
  assert.match(line(workHelp, 'pullboard request reopen'), /--level light\|mid\|strong/u);
  assert.match(workHelp, /--level strong\|mid\|light/u);
  assert.match(line(coordinatorHelp, 'pullboard sweep'), /--level light/u);
  assert.doesNotMatch(line(coordinatorHelp, 'pullboard sweep'), /--route/u);
});
