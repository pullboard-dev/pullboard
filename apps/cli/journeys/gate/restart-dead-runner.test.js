/** `pullboard next` brings this machine's dead local runner back while a gate job waits, and says so in one line [C7,#6556]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  fixtureAdd,
  withFixtureBoard,
} from '../../tests/fixtures/testkit.js';
import {
  createJob,
  writeStep,
} from '../../../../packages/jobs/index.js';

test('clause 1: next restarts the local runner when this machine\'s gate job has no live runner and prints one line saying so [C7,#6556]', async t => {
  const helpers = createE2eHelpers();
  const sandbox = helpers.sandbox();
  let box;
  try { box = helpers.project('true', sandbox); }
  catch (error) { helpers.cleanup(); throw error; }
  const state = join(sandbox.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'state.json');
  t.after(() => {
    // The restarted runner is a real detached process: stop it before the fixture is removed.
    try { process.kill(JSON.parse(readFileSync(state, 'utf8')).pid); } catch { /* it never started or already ended */ }
    helpers.cleanup();
  });
  const added = fixtureAdd(box.run, box.repo, 'web', 'Waits for a dead runner', '--specs', 'G1', '--criterion', 'Done.', '--check', 'true', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id), '--json')).code, 0);
  const at = Date.now() - 120_000;
  // @pullboard-board-file journey: leave an offered gate job and no live local runner, as a killed runner does.
  withFixtureBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), board => {
    createJob(board.db, { id: `gate:${id}:dead`, kind: 'gate', item: id, candidate: 'd'.repeat(40), now: at });
    writeStep(board.db, `gate:${id}:dead`, 'offered', {}, { now: at });
  });
  assert.equal(existsSync(state), false, 'no local runner has run yet');
  const next = await box.runLocal(box.web, 'next');
  const lines = next.out.split('\n').filter(line => line.includes('restarted this machine\'s local runner'));
  assert.equal(lines.length, 1, next.out + next.err);
  assert.ok(lines[0].includes(`#${id}`), lines[0]);
  assert.ok(existsSync(state), 'the local runner wrote its state');
});
