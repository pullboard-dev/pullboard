/** Machine acceptance passes the accept move's state and notBuilder guards before it records a verdict [V1]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { acceptMachineSubmission } from '../../src/io/machine.js';
import { machineBarDigest } from '../../src/logic/verdict/machine.js';
import { moveItem } from '../../../store/src/io/board.js';

const CHECK = 'node --test one.test.js';
const COMMIT = 'c'.repeat(40);
const TREE = 't'.repeat(40);
const MAIN = 'm'.repeat(40);

/** A board holding only the rows machine acceptance reads, plus a submitted item the coordinator may accept by machine. */
function fixture({ status = 'submitted', builtBy = 'seat-1' } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT); CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_files TEXT)');
  db.prepare('INSERT INTO item (item_id, item_files) VALUES (7, ?)').run('docs/a.txt');
  const item = { item_id: 7, item_status: status, item_criterion: '1. It works. [command]', item_check: CHECK, item_spec_ids: 'V1', item_brief: 'brief',
    item_commit: COMMIT, item_tree: TREE, item_merged_commit: null, item_built_by: builtBy, item_frozen_digest: 'digest', item_files: 'docs/a.txt' };
  const authorization = { version: 1, enabled: true, bar: machineBarDigest(item), commands: [{ clause: 1, command: 'node --test two.test.js' }] };
  item.item_frozen = JSON.stringify({ check: CHECK, machineVerification: authorization });
  db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('machine_verification:7', JSON.stringify(authorization));
  const receipt = (id, command) => ({ id, version: 2, green: true, command: createHash('sha256').update(command).digest('hex'), head: COMMIT, tree: TREE, main: MAIN,
    proof: { item: 7, frozenDigest: 'digest', seat: 'seat-1', exitCode: 0, sourceClean: true, environment: { platform: 'test' } } });
  const options = { commit: COMMIT, tree: TREE, policyCommit: MAIN, agentId: 'seat-1', files: ['docs/a.txt'],
    machineReceipts: [receipt('r1', CHECK), receipt('r2', 'node --test two.test.js')] };
  const calls = [];
  const deps = { getItem: (board, id) => ({ ...item, item_id: id }), logEvent: (...args) => calls.push(['event', ...args]),
    moveItem: (board, id, verb, how) => { calls.push(['move', verb, how]); return moveItem !== undefined ? how : null; } };
  return { db: { db }, item, options, deps, calls };
}

test('machine acceptance gives the accept move a real notBuilder check and passes it for a seat-built item [V1]', () => {
  const box = fixture();
  acceptMachineSubmission(box.db, box.item, box.options, box.deps);
  const how = box.calls.find(call => call[0] === 'move')[2];
  assert.equal(typeof how.checks.notBuilder, 'function', 'notBuilder is checked, not skipped');
  assert.equal(how.checks.notBuilder({ item_id: 7, item_built_by: 'seat-1' }), null);
  assert.equal(how.checks.notBuilder({ item_id: 7, item_built_by: 'coordinator' }).code, 'SELF_VERIFY');
});

test('machine acceptance refuses NOT_SUBMITTED for an item that left submitted [V1]', () => {
  for (const status of ['verified', 'open', 'claimed']) {
    const box = fixture({ status });
    assert.throws(() => acceptMachineSubmission(box.db, box.item, box.options, box.deps), (error) => error.code === 'NOT_SUBMITTED', status);
    assert.equal(box.calls.length, 0, 'no move and no event is written');
  }
});
