/** Durable gate 12/20: driveOnce refuses with a code when a transition lacks what it needs; drainLoop runs it to the verdict [C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { cleanupFixtureChildren } from '../../../cli/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { openBoard } from '../../index.js';
import { closeBoard } from '../../index.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { driveOnce } from '../../../../packages/drive/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { drainLoop } from '../../../../packages/drive/index.js';

after(cleanupFixtureChildren);

/** Open a fresh real board file and hand its SQLite handle to the body. */
async function withBoard(body) {
  const files = privateFixtureFiles('pullboard-drive12-board-');
  const board = openBoard(':memory:');
  try { return await body(board.db, files.root); } finally { closeBoard(board); }
}

test('lib.durable-drive.driveonce-refuses-with-a-code-when: clause 1: driveOnce refuses with a code when a transition lacks what it needs [C7]', async () => {
  await withBoard(async (db) => {
    createJob(db, { id: 'g3', kind: 'gate', now: 1 });
    await assert.rejects(driveOnce(db, 'g3', {}), { code: 'DRIVE_OWNER' });
    await assert.rejects(driveOnce(db, 'none', { owner: 'a' }), { code: 'JOB_MISSING' });
    await assert.rejects(driveOnce(db, 'g3', { owner: 'a', repo: '/nowhere', now: () => 5 }), { code: 'DRIVE_CANDIDATE' });
  });
});

test('lib.durable-drive.drainloop-calls-driveonce-until-the-job: clause 1: drainLoop calls driveOnce until the job reaches its terminal step [C7]', async () => {
  const board = openBoard(':memory:');
  try {
    createJob(board.db, { id: 'loop', kind: 'gate', now: 1 });
    const phases = ['captured', 'running', 'running', 'collected', 'verdict'];
    const calls = [];
    const drive = async (db, job, options) => {
      calls.push(options.owner);
      const phase = phases[calls.length - 1];
      return { transition: phase === phases[calls.length - 2] ? null : phase, phase, job: jobView(db, job) };
    };
    const last = await drainLoop(board.db, 'loop', { owner: 'w', drive, intervalMs: 1 });
    assert.equal(last.phase, 'verdict');
    assert.deepEqual(calls, ['w', 'w', 'w', 'w', 'w'], 'one driveOnce per step, resting only when a call moved nothing');
    const leased = await drainLoop(board.db, 'loop', { owner: 'w', drive: async () => ({ transition: null, phase: 'running', code: 'JOB_LEASED' }) });
    assert.equal(leased.code, 'JOB_LEASED', 'a loop stops when another driver holds the live lease');
  } finally { closeBoard(board); }
});
