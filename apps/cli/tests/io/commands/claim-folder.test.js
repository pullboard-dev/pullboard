/** A folder refusal met after a claim is recorded is reported as claimed with a folder next step, never as a refusal (#5766) [B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused } from '../../../../../packages/kernel/index.js';
import { claimedFolderProblem } from '../../../src/io/item/folder.js';

test('cli.io-commands-claim-folder.a-recorded-claim-whose-folder-refuses-carries: a recorded claim whose folder refuses carries the code, the plain message and a next step for the folder (#5766) [B3,C7]', () => {
  const problem = claimedFolderProblem(new Refused('ITEM_FOLDER_SESSION_LIVE', 'item folder /x/web-1-item-7 is in use by web-2\'s live session'), 7);
  assert.equal(problem.code, 'ITEM_FOLDER_SESSION_LIVE');
  assert.equal(problem.message, 'item folder /x/web-1-item-7 is in use by web-2\'s live session');
  assert.equal(problem.next, 'fix the item folder (ITEM_FOLDER_SESSION_LIVE), then pullboard claim 7 to open it');
});

test('cli.io-commands-claim-folder.a-folder-refusal-that-knows-its-own: a folder refusal that knows its own recovery keeps it as the next step (#5766) [B3,C7]', () => {
  const problem = claimedFolderProblem(new Refused('ITEM_FOLDER_DIRTY', 'item folder /x has dirty files a.txt', 'git -C /x status'), 7);
  assert.equal(problem.next, 'git -C /x status');
});
