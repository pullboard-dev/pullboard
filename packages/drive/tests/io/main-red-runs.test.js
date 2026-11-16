/** The main-red lookup writes its main-test job row to the runs file when runs_store is on, and to the board when off [P7,C7,#9080]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { boardRunsHolder } from '../../../store/index.js';
import { runsFilePath } from '../../../store/index.js';
import { classifyGateRed } from '../../index.js';
import { mainRedLookup } from '../../index.js';

const tree = 'c'.repeat(40);
const file = 'packages/drive/tests/io/a.test.js';
const command = 'node --test';

/** A file-backed board with runs_store set as given, and its path. */
function board(t, on) {
  const open = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const path = open.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  if (on) open.db.prepare("INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES ('runs_store', '1')").run();
  return { open, path };
}

/** The ids of the job rows a handle holds. */
const jobs = db => db.prepare('SELECT job_id FROM job').all().map(row => row.job_id);

test('clause 1: with runs_store on, mainRedLookup and classifyGateRed write their main-test job rows only to the runs file [P7,C7,#9080]', t => {
  const { open, path } = board(t, true);
  const runs = boardRunsHolder(open, path);
  assert.ok(runs, 'the flag is on, so the board gives a runs holder');
  assert.equal(existsSync(runsFilePath(path)), false, 'the runs file opens only on first use');
  const lookup = mainRedLookup(open.db, [], { tree, file, command, now: 1000, runs });
  assert.ok(lookup.job);
  const classified = classifyGateRed(open.db, [], { tree, file: 'packages/drive/tests/io/b.test.js', command, reds: ['x'], now: 2000, runs });
  assert.ok(classified.job);
  assert.deepEqual(jobs(runs.db).sort(), [lookup.job, classified.job].sort());
  assert.deepEqual(jobs(open.db), [], 'the board holds no main-test job row');
});

test('clause 2: with runs_store off, they write the same board job rows as on main [P7,C7,#9080]', t => {
  const { open, path } = board(t, false);
  assert.equal(boardRunsHolder(open, path), null);
  const lookup = mainRedLookup(open.db, [], { tree, file, command, now: 1000, runs: null });
  const classified = classifyGateRed(open.db, [], { tree, file: 'packages/drive/tests/io/b.test.js', command, reds: ['x'], now: 2000 });
  assert.deepEqual(jobs(open.db).sort(), [lookup.job, classified.job].sort());
  assert.equal(existsSync(runsFilePath(path)), false, 'no runs file is made');
});
