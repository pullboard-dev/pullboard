/** The wake timer's two files have one path function, and the scheduler's lock sites use it [C7,#8623]. @pullboard-test-input source-cell packages/gate */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { waitMainAudit } from '../../../../src/io/main/audit/scheduler.js';
import { saveMainAudit } from '../../../../src/io/main/audit/state.js';
import { timerFiles } from '../../../../src/io/main/audit/state.js';

test('gate.audit.timer-files-names: clause 1: timerFiles names timer.json and timer.guard.sqlite under the directory [C7]', () => {
  assert.deepEqual(timerFiles('/d'), { guard: join('/d', 'timer.guard.sqlite'), timer: join('/d', 'timer.json') });
});

test('gate.audit.timer-files-scheduler: clause 2: the scheduler wait site locks the guard and clears the record timerFiles names [C7]', async () => {
  const box = privateFixtureFiles('pb-timer-files-');
  const { guard, timer } = timerFiles(box.root);
  const dueAt = new Date(Date.now() - 1000).toISOString();
  saveMainAudit(timer, { version: 1, pid: process.pid, started: null, token: 't1', dueAt });
  assert.equal(await waitMainAudit(box.root, 't1', dueAt), true);
  assert.equal(existsSync(timer), false, 'the timer record at the named path was cleared');
  assert.equal(existsSync(guard), true, 'the lock guard was taken at the named path');
});
