/** One wait cause is one item whatever the holder's pid: a new pid adds a fact, never an item [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../apps/cli/tests/fixtures/board.js';
import { addItem } from '../../../store/index.js';
import { appendFact } from '../../../store/index.js';
import { register } from '../../../store/index.js';
import { itemThread } from '../../../store/index.js';
import { openWaitKey } from '../../index.js';
import { recordWaits } from '../../index.js';
import { waitBudgets } from '../../index.js';
import { waitItemFields } from '../../index.js';
import { waitPidRecorded } from '../../index.js';
import { waitKey } from '../../index.js';
import { waitItemDraft } from '../../src/logic/budgets.js';

const row = (pid, extra = {}) => ({ surface: 'pool', key: `machine:gate:pid-${pid}-abc`, holder: `gate by pid-${pid}-abc`, pid, ageMs: 40 * 60_000,
  budgetMs: 20 * 60_000, budgetName: 'pool', waiters: [], evidence: 'e', context: null, ...extra });

test('clause 2: the wait key and title carry no pid for two holders of one surface [C7]', () => {
  assert.equal(waitKey(row(111)), waitKey(row(222)));
  assert.doesNotMatch(waitKey(row(111)), /111/u);
  assert.equal(waitItemDraft(row(111)).title, waitItemDraft(row(222)).title);
  assert.doesNotMatch(waitItemDraft(row(111)).title, /111/u);
});

test('clause 1: two over-budget holders of one surface with different pids leave one open item and a fact [C7]', async t => {
  const board = fixtureBoard(t);
  register(board, { lane: 'coordinator', path: '/tmp' });
  const ports = {
    openKey: key => openWaitKey(board.db, key),
    repeat: async (id, text, pid) => { if (!waitPidRecorded(board.db, id, pid)) appendFact(board, id, { agentId: 'coordinator', kind: 'note', text }); },
    fileItem: draft => addItem(board, waitItemFields(draft, 'coordinator')),
    shout: () => {},
  };
  const snapshot = pid => ({ budgets: { ...waitBudgets(), file: true, reclaim: false }, rows: [{ ...row(pid), breach: true }] });
  const first = await recordWaits(snapshot(111), ports);
  const second = await recordWaits(snapshot(222), ports);
  const third = await recordWaits(snapshot(222), ports);
  assert.equal(first.filed.length, 1);
  assert.equal(second.filed.length, 0);
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM item WHERE item_brief LIKE '%Wait key:%'").get().n, 1);
  const id = first.filed[0].id;
  assert.equal(itemThread(board, id).filter(entry => JSON.stringify(entry).includes('(pid 222)')).length, 1, 'the new pid is one fact, not one per minute');
  assert.equal(third.filed.length, 0);
});
