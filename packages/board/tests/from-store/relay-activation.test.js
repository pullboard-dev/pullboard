/** Indexed activation preserves the recorded prefix and exact grant floors [E21,H16,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../store/index.js';
import { openCellBoard as openBoard } from '../fixtures/cell-board.js';
import { openBoardForRead } from '../../../store/index.js';
import { agentGrantMinimum } from '../../../state/index.js';
import { AGENT_GRANT_ENGINE } from '../../../state/index.js';
import { RIGOR_INSTRUCTIONS_ENGINE } from '../../../state/index.js';
import { appliedSequence } from '../../../state/index.js';
import { applyEngineMove } from '../../../state/index.js';
import { prepareEngineMove } from '../../../state/index.js';
import { startRelayEpoch } from '../../../state/index.js';
import { exportBoard } from '../../../store/index.js';
import { importBoard } from '../../../store/index.js';
import { restoreRelaySnapshot } from '../../../store/index.js';
import { recordSchemaStamp } from '../../../store/index.js';
import { SCHEMA_DIGEST } from '../../../store/index.js';

const AT = '2026-10-01T12:00:00.000Z';
const LEGACY = AGENT_GRANT_ENGINE - 1;

/** Execute real legacy receipts without activating grants merely by opening a newer writer. */
function fixture(t) {
  const board = openBoard(':memory:', { now: () => new Date(AT) });
  t.after(() => store.closeBoard(board));
  let number = 0;
  /** Use the actual engine, monotonically ordered positions and unique immutable move ids. */
  function move(operation, args, engine = LEGACY) {
    const request = { ...prepareEngineMove(board, operation, args, { id: `activation-${++number}` }), engine };
    const receipt = { sequence: appliedSequence(board) + 1, at: AT };
    const outcome = applyEngineMove(board, request, receipt);
    assert.equal(outcome.error, undefined, JSON.stringify(outcome));
    return { request, receipt, outcome };
  }
  move('register', [{ lane: 'coordinator', path: '/activation-fixture/main' }]);
  const actor = move('register', [{ lane: 'web', path: '/activation-fixture/web' }]).outcome.result;
  move('addItem', [{ by: 'coordinator', lane: 'web', title: 'Unmarked legacy item', criterion: 'Keep its original authority' }]);
  const probe = { ...prepareEngineMove(board, 'editItem', [1, { agentId: actor, title: 'A later edit' }]), engine: LEGACY };
  /** A real modern receipt is the witness, even when the activating operation is administrative. */
  const activate = () => move('shout', [{ from: 'coordinator', to: actor, text: 'Modern engine recorded', lanes: ['web'] }], RIGOR_INSTRUCTIONS_ENGINE);
  return { board, actor, probe, move, activate };
}

/** Observe the real predicate's query plan without changing its SQL, bindings or result. */
function lookupPlan(board, probe) {
  const prepare = board.db.prepare.bind(board.db);
  const plans = [];
  board.db.prepare = sql => {
    if (sql.includes("meta_key GLOB 'relay_receipt_*'") && sql.includes('json_extract')) {
      const placeholders = (sql.match(/\?/gu) ?? []).length;
      const bindings = [appliedSequence(board), AGENT_GRANT_ENGINE].slice(0, placeholders);
      plans.push(...prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map(row => row.detail));
    }
    return prepare(sql);
  };
  try { return { floor: agentGrantMinimum(board, probe), plans }; }
  finally { board.db.prepare = prepare; }
}

/** Use the literal pre-index predicate as an oracle for readable legacy types and corrupt-row behavior. */
function originalFloor(board) {
  const row = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_applied_sequence'").get();
  const sequence = row ? Number(row.meta_value) : 0;
  if (!Number.isSafeInteger(sequence) || sequence < 1) return 1;
  const witness = board.db.prepare(`SELECT 1 FROM board_meta WHERE meta_key GLOB 'relay_receipt_*'
    AND json_extract(meta_value, '$.sequence') <= ?
    AND json_extract(json_extract(meta_value, '$.move'), '$.engine') >= ? LIMIT 1`)
    .get(sequence, AGENT_GRANT_ENGINE);
  return witness ? AGENT_GRANT_ENGINE : 1;
}

/** Compare the actual return or SQLite error without swallowing either path's original result. */
function observed(work) {
  try { return { result: work() }; }
  catch (error) { return { error: { code: error.code, errcode: error.errcode, message: error.message } }; }
}

test('recorded activation preserves pre/post floors, acknowledged replay and administrative ordering [E21,H16]', t => {
  const box = fixture(t);
  const { board, actor, probe } = box;
  assert.equal(agentGrantMinimum(board, probe), 1);
  const old = box.move('shout', [{ from: actor, to: 'coordinator', text: 'Old acknowledged message', lanes: ['web'] }]);
  box.activate();
  assert.equal(agentGrantMinimum(board, probe), AGENT_GRANT_ENGINE);
  const cursor = appliedSequence(board);
  assert.throws(() => applyEngineMove(board, probe, { sequence: cursor + 1, at: AT }),
    error => error.code === 'RELAY_MOVE' && error.message.includes(String(AGENT_GRANT_ENGINE)));
  assert.equal(appliedSequence(board), cursor, 'a floor refusal does not advance the prefix');
  assert.deepEqual(applyEngineMove(board, old.request, old.receipt), old.outcome, 'acknowledged legacy replay remains exact');
  const administrative = { ...prepareEngineMove(board, 'shout', [{ from: actor, to: 'coordinator', text: 'Still administrative', lanes: ['web'] }]), engine: LEGACY };
  assert.equal(agentGrantMinimum(board, administrative), 1, 'current administrative early-return ordering is unchanged');
  assert.equal(applyEngineMove(board, administrative, { sequence: cursor + 1, at: AT }).error, undefined);
});

test('a rolled-back activation never becomes a witness [E21,H16]', t => {
  const box = fixture(t);
  const before = exportBoard(box.board);
  const original = new Error('rollback the genuine native activation');
  assert.throws(() => store.atomic(box.board, () => { box.activate(); throw original; }), error => error === original);
  assert.deepEqual(exportBoard(box.board), before, 'native events, receipts, cursor and identities roll back together');
  assert.equal(agentGrantMinimum(box.board, box.probe), 1);
  box.activate();
  assert.equal(agentGrantMinimum(box.board, box.probe), AGENT_GRANT_ENGINE, 'a later committed activation is visible');
});

test('import, newer checkpoint and epoch reset use their actual receipt witness [E21,H16]', t => {
  const box = fixture(t);
  const legacy = exportBoard(box.board);
  box.activate();
  const activated = exportBoard(box.board);
  const peer = openBoard(':memory:');
  t.after(() => store.closeBoard(peer));
  importBoard(peer, legacy);
  assert.equal(agentGrantMinimum(peer, box.probe), 1);
  restoreRelaySnapshot(peer, activated, appliedSequence(box.board));
  assert.equal(agentGrantMinimum(peer, box.probe), AGENT_GRANT_ENGINE);
  const identity = peer.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
  startRelayEpoch(peer, identity);
  assert.equal(agentGrantMinimum(peer, box.probe), 1, 'a real epoch reset removes the old witness on the same connection');
});

test('a receipt beyond the applied cursor cannot activate the recorded prefix [E21,H16]', t => {
  const box = fixture(t);
  const before = appliedSequence(box.board);
  box.activate();
  // Disposable-fixture metadata models a stored receipt outside the restored applied prefix.
  box.board.db.prepare("UPDATE board_meta SET meta_value=? WHERE meta_key='relay_applied_sequence'").run(String(before));
  assert.equal(agentGrantMinimum(box.board, box.probe), 1, 'the witness must satisfy sequence <= the applied cursor');
  box.board.db.prepare("UPDATE board_meta SET meta_value=? WHERE meta_key='relay_applied_sequence'").run(String(before + 1));
  assert.equal(agentGrantMinimum(box.board, box.probe), AGENT_GRANT_ENGINE, 'the exact boundary includes its witness');
});

test('activation lookup excludes old engines and seeks sequence as genuine receipts grow [E21,C7]', t => {
  const box = fixture(t);
  const observations = [];
  for (const population of [8, 1024]) {
    while (appliedSequence(box.board) < population) {
      box.move('shout', [{ from: box.actor, to: 'coordinator', text: `Legacy receipt ${appliedSequence(box.board)}`, lanes: ['web'] }]);
    }
    const lookup = lookupPlan(box.board, box.probe);
    observations.push({ receipts: population, ...lookup });
  }
  t.diagnostic(JSON.stringify({ method: 'actual predicate EXPLAIN QUERY PLAN at two native receipt populations; no wall-time inference', observations }));
  for (const { floor, plans } of observations) {
    assert.equal(floor, 1);
    assert.ok(plans.some(plan => /SEARCH board_meta USING INDEX board_meta_grant_activation_v2.*<expr><\?/u.test(plan)),
      `lookup must seek the applied sequence inside qualifying engines: ${JSON.stringify(plans)}`);
  }
  const definition = box.board.db.prepare("SELECT sql FROM sqlite_master WHERE name='board_meta_grant_activation_v2'").get().sql;
  assert.ok(definition.includes("json_extract(json_extract(meta_value, '$.move'), '$.engine')"));
  assert.match(definition, new RegExp(`>= ${AGENT_GRANT_ENGINE}\\b`, 'u'), 'the index excludes old-engine rows before the sequence seek');
  box.activate();
  assert.equal(lookupPlan(box.board, box.probe).floor, AGENT_GRANT_ENGINE);
});

test('activation seeks the applied sequence even when modern receipts are all in the future [E21,H16,C7]', t => {
  const box = fixture(t);
  const before = appliedSequence(box.board);
  box.activate();
  while (appliedSequence(box.board) < 1024) {
    box.move('shout', [{ from: box.actor, to: 'coordinator', text: `Modern receipt ${appliedSequence(box.board)}`, lanes: ['web'] }], AGENT_GRANT_ENGINE);
  }
  const recorded = appliedSequence(box.board);
  // All receipts above are genuine executions; this private cursor models a restored earlier prefix.
  box.board.db.prepare("UPDATE board_meta SET meta_value=? WHERE meta_key='relay_applied_sequence'").run(String(before));
  const lookup = lookupPlan(box.board, box.probe);
  t.diagnostic(JSON.stringify({ recordedReceipts: recorded, appliedCursor: before, ...lookup }));
  assert.equal(lookup.floor, 1, 'unapplied modern receipts are not witnesses');
  assert.ok(lookup.plans.some(plan => /SEARCH board_meta USING INDEX board_meta_grant_activation_\w+.*<expr><\?/u.test(plan)),
    `the sequence cutoff must be an indexed range, not a filter after scanning future engines: ${JSON.stringify(lookup.plans)}`);
});

test('indexed activation retains original JSON types and malformed-receipt short circuits [E21,H16]', t => {
  const box = fixture(t);
  const { board, probe } = box;
  const cursor = appliedSequence(board);
  const write = board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES (?,?)');
  const remove = board.db.prepare('DELETE FROM board_meta WHERE meta_key=?');
  const move = engine => JSON.stringify({ ...probe, engine });
  // These are explicitly simulated legacy/corrupt metadata values, not claims of executed engine receipts.
  const samples = [
    JSON.stringify({ sequence: cursor, move: move(AGENT_GRANT_ENGINE) }),
    JSON.stringify({ sequence: cursor + 1, move: move(AGENT_GRANT_ENGINE) }),
    JSON.stringify({ sequence: String(cursor), move: move(AGENT_GRANT_ENGINE) }),
    JSON.stringify({ sequence: null, move: move(AGENT_GRANT_ENGINE) }),
    JSON.stringify({ sequence: cursor, move: move(String(AGENT_GRANT_ENGINE)) }),
    JSON.stringify({ sequence: cursor, move: move(null) }),
    JSON.stringify({ sequence: cursor, move: { engine: AGENT_GRANT_ENGINE } }),
    `{sequence:${cursor},move:'{engine:${AGENT_GRANT_ENGINE},}',}`,
    Buffer.from(JSON.stringify({ sequence: cursor, move: move(AGENT_GRANT_ENGINE) })),
  ];
  for (const sample of samples) {
    write.run('relay_receipt_simulated', sample);
    const stored = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_receipt_simulated');
    assert.deepEqual(observed(() => agentGrantMinimum(board, probe)), observed(() => originalFloor(board)));
    assert.deepEqual(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_receipt_simulated'), stored,
      'lookup never repairs or rewrites legacy receipt bytes');
  }
  remove.run('relay_receipt_simulated');
  const witness = JSON.stringify({ sequence: cursor, move: move(AGENT_GRANT_ENGINE) });
  const broken = ['not JSON', JSON.stringify({ sequence: cursor, move: 'not JSON' }), Buffer.from('not JSON')];
  for (const sample of broken) {
    for (const before of [true, false]) {
      write.run(before ? 'relay_receipt_0-witness' : 'relay_receipt_z-witness', witness);
      write.run(before ? 'relay_receipt_z-broken' : 'relay_receipt_0-broken', sample);
      assert.deepEqual(observed(() => agentGrantMinimum(board, probe)), observed(() => originalFloor(board)),
        'malformed outer and inner values retain the original witness-before/error-before behavior');
      for (const key of ['relay_receipt_0-witness', 'relay_receipt_z-witness', 'relay_receipt_z-broken', 'relay_receipt_0-broken']) remove.run(key);
    }
  }
});

test('owning open upgrades an old indexless board once without changing native data or read-only ownership [E21,H16,C7]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-activation-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'board.sqlite');
  // @pullboard-board-file migration: the file is reopened through each activation step
  let board = openBoard(file);
  let document;
  let version;
  try {
    store.board_ensureCoordinator(board, dir);
    const legacy = { ...prepareEngineMove(board, 'shout', [{ from: 'coordinator', to: 'all', text: 'Legacy receipt', lanes: ['web'] }]), engine: LEGACY };
    assert.equal(applyEngineMove(board, legacy, { sequence: 1, at: AT }).error, undefined);
    document = exportBoard(board);
    version = board.db.prepare('PRAGMA user_version').get().user_version;
    // Model an otherwise-current legacy board with its original, indexless schema stamp.
    board.db.exec('DROP INDEX IF EXISTS board_meta_grant_activation_v2; DROP INDEX IF EXISTS board_meta_grant_activation_unsafe_v1');
    recordSchemaStamp(board.db, SCHEMA_DIGEST);
  } finally { store.closeBoard(board); }
  const read = openBoardForRead(file);
  try {
    assert.equal(read.current, true, 'old indexless boards remain readable at the same native schema version');
    assert.equal(read.db.prepare("SELECT 1 FROM sqlite_master WHERE name='board_meta_grant_activation_v2'").get(), undefined);
  } finally { read.db.close(); }
  // @pullboard-board-file migration: the file is reopened through each activation step
  board = openBoard(file, undefined, { isMain: false });
  try {
    assert.equal(board.db.prepare("SELECT 1 FROM sqlite_master WHERE name='board_meta_grant_activation_v2'").get(), undefined,
      'a non-owner never installs the additive index');
    const probe = { operation: 'editItem', args: [1, { agentId: 'unmarked-web-seat' }] };
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      assert.equal(agentGrantMinimum(board, probe), originalFloor(board));
      assert.equal(agentGrantMinimum(board, probe), originalFloor(board));
    } finally { console.warn = warn; }
    assert.equal(warnings.length, 1, 'missing-index fallback emits only one notice per process');
    assert.match(warnings[0], /^\[RELAY_ACTIVATION_INDEX_MISSING\].*owning main checkout/u);
    assert.equal(board.db.prepare("SELECT 1 FROM sqlite_master WHERE name='board_meta_grant_activation_v2'").get(), undefined,
      'the fallback remains read-only and does not refuse or install an index');
  } finally { store.closeBoard(board); }
  // @pullboard-board-file migration: the file is reopened through each activation step
  board = openBoard(file);
  try {
    assert.ok(board.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='board_meta_grant_activation_v2'").get(),
      'the owning writable opener installs the missing index on an already-current board');
    assert.equal(board.db.prepare('PRAGMA user_version').get().user_version, version);
    assert.deepEqual(exportBoard(board), document, 'index installation leaves every native row and export field unchanged');
  } finally { store.closeBoard(board); }
  const stamped = openBoardForRead(file);
  try { assert.equal(stamped.current, true, 'installation and the actual index-shape stamp commit together'); }
  finally { stamped.db.close(); }
  // @pullboard-board-file migration: the file is reopened through each activation step
  board = openBoard(file);
  try {
    assert.equal(board.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='board_meta_grant_activation_v2'").get().n, 1);
    assert.deepEqual(exportBoard(board), document, 'a second owning open is idempotent');
  } finally { store.closeBoard(board); }
});
