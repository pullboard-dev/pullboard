/** sentinels.recordWriteHolder keeps who held a slow board write, durably, and records nothing while off [C7,#9118]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeSetting } from '../../../config/index.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { temporaryDirectory } from '../../../board/tests/fixtures/board.js';
import { recordWaits } from '../../index.js';
import { waitBudgets } from '../../index.js';
import { waitsSnapshot } from '../../index.js';
import { readWriteHolders } from '../../index.js';
import { writeHolderRecorder } from '../../index.js';
import { localCensus } from '../../src/io/surfaces.js';

/** A real board file, repo folder and machine home, with a live holder and a live waiter marker 5 s and 3 s old. */
function slowWrite(t, settings) {
  const root = temporaryDirectory('pullboard-write-holder-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine-home');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  });
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const boardFile = board.db.prepare('PRAGMA database_list').get().file;
  const commonDir = join(root, 'repo.git');
  mkdirSync(join(commonDir, 'pullboard'), { recursive: true });
  const markers = `${boardFile}.write-holders`;
  mkdirSync(markers, { recursive: true });
  // This process holds the write and its parent waits: both are live, so no child process is needed.
  const live = [process.pid, process.ppid];
  [5_000, 3_000].forEach((age, index) => {
    writeFileSync(join(markers, `${live[index]}-00000000-0000-0000-0000-00000000000${index + 1}.json`), JSON.stringify({ version: 1, pid: live[index],
      started: '', processSha256: 'a'.repeat(64), command: index ? 'add' : 'merged', seat: index ? 'core-2' : 'coordinator', acquiredAt: Date.now() - age }));
  });
  const paths = { commonDir, boardFile, machineHome: join(root, 'home'), handoffQueue: join(root, 'home', 'handoff-queue') };
  const census = new Map([...localCensus()].filter(([pid]) => live.includes(pid)));
  const record = async () => {
    const snapshot = await waitsSnapshot({ paths, budgets: waitBudgets(), hosts: [], census });
    return recordWaits({ ...snapshot, budgets: { ...snapshot.budgets, file: false } }, { observeHolder: writeHolderRecorder(board.db) });
  };
  return { board, live, record };
}

test('sentinels.write-holder.setting-on-records-holder: clause 1: with sentinels.recordWriteHolder on, a board write held past boardWriteMs records the holder and each waiter [C7,#9118]', async t => {
  const m = slowWrite(t, { sentinels: { recordWriteHolder: true } });
  await m.record();
  const lines = readWriteHolders(m.board.db);
  assert.equal(lines.length, 1);
  const [one] = lines;
  assert.equal(one.holderPid, m.live[0]);
  assert.match(one.command, /node/u, 'the holder\'s command line');
  assert.ok(one.heldMs > one.budgetMs, 'the time it was held, past the budget');
  assert.deepEqual(one.waiters.map(waiter => waiter.pid), [m.live[1]]);
  assert.equal(typeof one.waiters[0].waitMs, 'number', 'and how long the waiter waited');
  assert.ok(one.waiters[0].waitMs > 0);
  await m.record();
  assert.equal(readWriteHolders(m.board.db).length, 1, 'the same holder is not recorded twice');
});

test('sentinels.write-holder.setting-off-records-nothing: clause 2: with sentinels.recordWriteHolder off (the default) nothing is recorded, and the setting is described [C7,#9118]', async t => {
  const m = slowWrite(t, {});
  await m.record();
  assert.deepEqual(readWriteHolders(m.board.db), []);
  const described = describeSetting('sentinels.recordWriteHolder');
  assert.ok(described?.label && described.description, 'the setting has a label and a sentence');
  assert.match(described.description, /off \(default\)/u);
});
