/** A submit handoff whose worker is gone is recovered whether it was queued or running, and the next submit queues [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { openBoard } from '../apps/lib/index.js';
import { getItem } from '../packages/store/index.js';
import { submitHandoff } from '../packages/store/index.js';
import { fixtureAdd } from './testkit-fixture.js';

/** Require authentic command success before interpreting any native result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read the real SQLite state the separate worker wrote, without writing anything. */
function state(box, id) {
  // @pullboard-board-file journey: observe the detached worker's actual persisted queue record.
  const board = openBoard(box.boardFile);
  try { return { item: getItem(board, id), job: submitHandoff(board, id) }; }
  finally { board.db.close(); }
}

/** Quote a private fixture path for the configured shell command. */
function word(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Whether a process is gone; any other signal error leaves it presumed alive. */
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** A native project with handoff on and a gate that holds while the candidate says "hold", until released. */
function fixture(t) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  const release = join(box.dir, 'release'), started = join(box.dir, 'started');
  const script = join(box.dir, 'gate.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    "const value = fs.existsSync('web/snapshot.txt') ? fs.readFileSync('web/snapshot.txt', 'utf8').trim() : 'base';",
    "if (value === 'hold') {",
    ` fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
    ' const deadline = Date.now() + 120000;',
    ` while (!fs.existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) throw Error('fixture release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
    '}',
  ].join('\n'));
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Dead running handoff', '--specs', 'G1',
    '--criterion', 'A dead running handoff never blocks the next submit.', '--check', `${word(process.execPath)} ${word(script)}`, '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  t.after(async () => {
    writeFileSync(release, 'release\n');
    await helpers.waitFor(() => !['queued', 'running'].includes(state(box, id).job?.state), 'queued worker finished', 120000); // budget: cleanup ceiling, no timing assertion.
    helpers.cleanup();
  });
  return { ...box, helpers, id, started };
}

test('a running handoff with a dead worker pid is recovered and a new submit queues [C7,V4]', async t => {
  const box = fixture(t);
  assert.equal(box.helpers.commitFile(box, box.web, 'web/snapshot.txt', 'hold\n', 'feat(web): held candidate [G1]').status, 0);
  assert.equal(document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json')).queued, true);
  await box.helpers.waitFor(() => existsSync(box.started) && state(box, box.id).job?.state === 'running', 'the gate is running', 120000); // budget: real worker start ceiling, no timing assertion.
  const first = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', first.id);
  const owner = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8'));
  // The worker leads its own detached process group; killing the group leaves no live gate behind, like a crash.
  process.kill(-owner.pid, 'SIGKILL');
  await box.helpers.waitFor(() => gone(owner.pid), 'the worker is gone', 120000); // budget: kill ceiling, no timing assertion.
  assert.equal(state(box, box.id).job.state, 'running', 'the dead worker left its job marked running');

  assert.equal(box.helpers.commitFile(box, box.web, 'web/snapshot.txt', 'pass\n', 'feat(web): next candidate [G1]').status, 0);
  const next = box.run(box.web, 'submit', String(box.id), '--no-next', '--json');
  assert.doesNotMatch(next.out + next.err, /SUBMIT_HANDOFF_PENDING/u, 'a dead running job never refuses the next submit');
  assert.equal(document(next).queued, true);
  const after = state(box, box.id);
  assert.notEqual(after.job.id, first.id, 'the next submit queued its own job');
  const retired = JSON.parse(readFileSync(join(directory, 'refusal.json'), 'utf8'));
  assert.equal(retired.error.code, 'SUBMIT_HANDOFF_DEAD');
  assert.match(retired.error.message, /running submit worker is dead/u);
  await box.helpers.waitFor(() => ['green', 'submitted'].includes(state(box, box.id).job?.state), 'the new gate finished', 120000); // budget: real gate ceiling, no timing assertion.
  assert.equal(state(box, box.id).item.item_status, 'submitted');
});
