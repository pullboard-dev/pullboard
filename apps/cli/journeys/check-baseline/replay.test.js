/** Captured baselines travel with board moves, and a check that is not valid shell is refused [C7,H3,H16]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { checkBaseline } from '../../../../packages/gate/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  BOARD_FILE,
  project,
  addChecked,
  showItem,
  shellWord,
  cleanupFixtures,
  withBoard,
  applyInReplica,
} from '../../tests/fixtures/check-baseline.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

/** Run the CLI through production dispatch in this process; same result shape as box.run [C7]. */
async function local(box, cwd, args, input, options = {}) {
  return runCliInProcess(args, { cwd, env: options.env ?? box.env, ...(input === undefined ? {} : { input }) });
}

after(cleanupFixtures);

/** Import one native snapshot into a separate real SQLite replica. */
function importReplica(file, snapshot) {
  withBoard(file, (board) => importBoard(board, snapshot));
}

/** Read a native snapshot from a replica, including its event and metadata tables. */
function snapshotFile(file) {
  return withBoard(file, exportBoard);
}

/** Read the shell's own parse message for a command, as the refusal must quote it. */
function shellParseMessage(command) {
  const parsed = spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8' });
  assert.notEqual(parsed.status, 0, 'the fixture command is a real syntax error');
  return parsed.stderr.trim().split('\n')[0].trim();
}

test('[H3,H16] captured add and edit baselines replay identically without running shell checks', async function baselineMoveReplay() {
  const box = project();
  const baseFile = join(box.repo, BOARD_FILE);
  const seed = snapshotFile(baseFile);
  const senderFile = join(box.dir, 'sender.sqlite');
  importReplica(senderFile, seed);
  const senderDir = join(box.dir, 'sender');
  const replicaA = join(box.dir, 'replica-a');
  const replicaB = join(box.dir, 'replica-b');
  for (const dir of [senderDir, replicaA, replicaB]) mkdirSync(dir);
  const fileA = join(replicaA, 'board.sqlite');
  const fileB = join(replicaB, 'board.sqlite');
  importReplica(fileA, seed);
  importReplica(fileB, seed);
  const markerA = join(replicaA, 'must-not-run');
  const markerB = join(replicaB, 'must-not-run');
  const shellCheck = `${shellWord(process.execPath)} -e ${shellWord(`require('node:fs').writeFileSync(process.cwd() + '/must-not-run', 'ran')`)}`;
  const baseline = {
    command: shellCheck,
    main: 'a'.repeat(40),
    result: 'red',
  };
  let move;
  withBoard(senderFile, (sender) => {
    move = prepareEngineMove(sender, 'addItem', [{
      by: 'coordinator', lane: 'web', title: 'Replayed baseline', criterion: 'the baseline stays captured',
      check: shellCheck, checkBaseline: baseline,
    }], { id: 'check-baseline-add' });
  });
  assert.deepEqual(move.args[0].checkBaseline, baseline, 'the measured object is embedded in the sender-authored move');
  withBoard(senderFile, (sender) => applyEngineMove(sender, move, { sequence: 1, at: '2026-10-07T12:00:00.000Z' }));
  const moveFile = join(box.dir, 'add-move.json');
  writeFileSync(moveFile, JSON.stringify(move));
  const envA = { ...box.env, CHECK_REPLICA: 'a', sequence: '1' };
  const envB = { ...box.env, CHECK_REPLICA: 'b', sequence: '1' };
  const appliedA = applyInReplica(fileA, replicaA, moveFile, envA);
  const appliedB = applyInReplica(fileB, replicaB, moveFile, envB);
  assert.equal(appliedA.status, 0, `${appliedA.stdout}${appliedA.stderr}`);
  assert.equal(appliedB.status, 0, `${appliedB.stdout}${appliedB.stderr}`);
  assert.equal(existsSync(markerA), false, 'replica A stores the captured result without running the command');
  assert.equal(existsSync(markerB), false, 'replica B stores the captured result without running the command');
  assert.deepEqual(snapshotFile(fileA), snapshotFile(fileB), 'both SQLite replicas commit the same item, baseline, event and receipt');

  const editBaseline = { ...baseline, command: `${shellCheck} --edited`, result: 'green' };
  let edit;
  withBoard(senderFile, (sender) => {
    const item = sender.db.prepare("SELECT item_id FROM item WHERE item_title='Replayed baseline'").get();
    edit = prepareEngineMove(sender, 'editItem', [item.item_id, {
      agentId: 'coordinator', check: editBaseline.command, checkBaseline: editBaseline,
    }], { id: 'check-baseline-edit' });
  });
  assert.deepEqual(edit.args[1].checkBaseline, editBaseline, 'the edited measurement is captured before replay too');
  withBoard(senderFile, (sender) => applyEngineMove(sender, edit, { sequence: 2, at: '2026-10-07T12:00:01.000Z' }));
  const editFile = join(box.dir, 'edit-move.json');
  writeFileSync(editFile, JSON.stringify(edit));
  const editedA = applyInReplica(fileA, replicaA, editFile, { ...envA, sequence: '2' }, '2026-10-07T12:00:01.000Z');
  const editedB = applyInReplica(fileB, replicaB, editFile, { ...envB, sequence: '2' }, '2026-10-07T12:00:01.000Z');
  assert.equal(editedA.status, 0, `${editedA.stdout}${editedA.stderr}`);
  assert.equal(editedB.status, 0, `${editedB.stdout}${editedB.stderr}`);
  assert.equal(existsSync(markerA), false);
  assert.equal(existsSync(markerB), false);
  assert.deepEqual(snapshotFile(fileA), snapshotFile(fileB), 'replayed edits preserve equal baseline and event metadata');
  assert.deepEqual(snapshotFile(senderFile), snapshotFile(fileA), 'sender and both receiving databases share the same add/edit history');
});

test('[C7,V4] a check that is not valid shell is refused when set', async () => {
  const box = project();
  const unbalanced = "grep -q 'it's done' web/result.txt";
  const said = shellParseMessage(unbalanced);
  const before = (await local(box, box.repo, ['list', '--json'])).stdout;

  const added = await local(box, box.repo, ['add', 'web', 'Unbalanced add', '--specs', 'G1', '--check', unbalanced, '--json']);
  assert.notEqual(added.status, 0, 'an unbalanced quote on add is refused');
  const addError = JSON.parse(added.stdout).error;
  assert.equal(addError.code, 'CHECK_SYNTAX', 'add refuses with CHECK_SYNTAX');
  assert.ok(addError.message.includes(said), `add quotes the shell's message: ${addError.message}`);
  assert.match(addError.next, /sh -n/u, 'the refusal names its specific next step');
  assert.equal((await local(box, box.repo, ['list', '--json'])).stdout, before, 'a refused add files no item');

  const valid = "grep -q 'green' web/result.txt";
  const { item } = addChecked(box, 'Valid check', valid);
  assert.equal(item.item_check, valid, 'a valid check is accepted on add');

  const edited = await local(box, box.repo, ['edit', String(item.item_id), '--check', unbalanced, '--json']);
  assert.notEqual(edited.status, 0, 'an unbalanced quote on edit is refused');
  const editError = JSON.parse(edited.stdout).error;
  assert.equal(editError.code, 'CHECK_SYNTAX', 'edit refuses with CHECK_SYNTAX');
  assert.ok(editError.message.includes(said), `edit quotes the shell's message: ${editError.message}`);
  assert.equal(showItem(box, item.item_id).item.item_check, valid, 'a refused edit keeps the old check');

  const revised = "grep -q 'gr''een' web/result.txt";
  const accepted = await local(box, box.repo, ['edit', String(item.item_id), '--check', revised, '--wait', '--json']);
  assert.equal(accepted.status, 0, `a valid check is accepted on edit: ${accepted.stdout}${accepted.stderr}`);
  assert.equal(showItem(box, item.item_id).item.item_check, revised);
});
