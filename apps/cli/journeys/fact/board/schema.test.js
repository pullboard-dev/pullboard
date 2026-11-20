/** Main owns declaration upgrades; valid old stamps and manual drift remain distinct [M3,A5,A6,C7,H16]. */
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { storeTriggers } from '../../../../../packages/state/index.js';
import { MACHINE } from '../../../../../packages/state/index.js';
import { SCHEMA_DIGEST } from '../../../../../packages/store/index.js';
import { SCHEMA_VERSION } from '../../../../../packages/store/index.js';
import { boardStanding } from '../../../../../packages/store/index.js';
import { recordSchemaStamp } from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { undoQueued } from '../../../../../packages/outbox/index.js';
import { pinAuthority } from '../../../../../packages/person/index.js';
import { setPersonSigning } from '../../../../../packages/person/index.js';
import { localAuthority } from '../../../../../packages/person/index.js';
import { restoreRelaySnapshot } from '../../../../../packages/store/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';


import { createSchemaFixture } from '../../../../../packages/store/tests/fixtures/schema-declaration.js';

const e2e = createE2eHelpers();
const { openRawBoard, olderDeclaration, observe, privateMainSource } = createSchemaFixture({
  MACHINE, storeTriggers, SCHEMA_DIGEST, SCHEMA_VERSION, boardStanding, recordSchemaStamp, copyPackageFiles });
after(e2e.cleanup);
// Clause 3: the file ends with no network socket or server alive, so the runner's file-exit timeout never waits on one [C7].
after(() => {
  const open = process.getActiveResourcesInfo().filter(name => /^(TCP|UDP)/u.test(name));
  assert.deepEqual(open, [], 'schema.test.js leaves no socket open when it ends');
});

/** Create a file-backed private board with ordinary native data and a valid legacy stamp. */
function legacyBoard(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-stamped-declaration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  const board = openBoard(file);
  // The additive declaration now holds the hop table, so a board these journeys call drifted already has it and main has nothing to add [C7,#8465].
  store.ensureGateHopTable(board.db);
  try { store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Keep this row' }); }
  finally { store.closeBoard(board); }
  olderDeclaration(file);
  return file;
}

test('cli.journeys-fact-board-schema.main-refreshes-a-valid-stamped-older: main refreshes a valid stamped older transition once; reads and branch opens leave it alone [M3,A5,A6,C7]', t => {
  const file = legacyBoard(t);
  const before = observe(file);
  assert.equal(before.standing, 'current', 'the old declaration has its own valid installed-shape stamp');
  const readonly = store.openBoardReadOnly(file);
  readonly.close();
  const branch = openBoard(file, undefined, { isMain: false, onDiagnostic: () => {} });
  store.closeBoard(branch);
  assert.deepEqual(observe(file), before, 'neither read-only nor non-main code installs a declaration');

  const main = openBoard(file);
  store.closeBoard(main);
  const upgraded = observe(file);
  const installed = upgraded.schema.find(row => row.name === 'machine_item_move').sql;
  assert.equal(installed, storeTriggers().find(row => row.name === 'machine_item_move').sql);
  assert.ok(installed.includes("'claimed>verified'"));
  assert.equal(upgraded.standing, 'current', 'the new declaration and its shape stamp commit together');
  assert.equal(upgraded.version, before.version);
  assert.equal(upgraded.identity, before.identity);
  assert.deepEqual(upgraded.items, before.items);
  assert.deepEqual(upgraded.guards.map(row => JSON.parse(row.event_detail)),
    [{ missing: [], changed: ['machine_item_move'], stale: [] }]);
  const bytes = readFileSync(file);
  const again = openBoard(file);
  store.closeBoard(again);
  assert.deepEqual(observe(file), upgraded, 'an already-current declaration emits no repair event');
  assert.deepEqual(readFileSync(file), bytes, 'an already-current declaration makes no persistent write');
});

test('cli.journeys-fact-board-schema.main-leaves-manually-drifted-triggers-and: main leaves manually drifted triggers and their invalid stamp untouched [M3,A5,A6,C7]', t => {
  const file = legacyBoard(t);
  const changed = new DatabaseSync(file);
  try { changed.exec('DROP TRIGGER machine_fields_claimed'); }
  finally { changed.close(); }
  const before = observe(file);
  assert.equal(before.standing, 'drifted');
  const diagnostics = [];
  const board = openBoard(file, undefined, { onDiagnostic: text => diagnostics.push(text) });
  store.closeBoard(board);
  assert.deepEqual(observe(file), before, 'a missing hand-edited trigger must not be silently approved or restamped');
  assert.match(diagnostics.join('\n'), /different shape/u);
});

test('cli.journeys-fact-board-schema.a-private-main-source-checkout-is: clause 1: a private main source checkout is the candidate tree in its own repository with no commit made of it [C7]', () => {
  const box = e2e.sandbox();
  const directory = join(box.dir, 'main-source');
  mkdirSync(directory);
  privateMainSource(box, directory);
  assert.ok(readFileSync(join(directory, 'apps/cli/pullboard.js'), 'utf8').length > 0, 'the candidate entry is copied');
  const gitDir = box.git(directory, 'rev-parse', '--absolute-git-dir');
  const common = box.git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.equal(realpathSync(gitDir.trim()), realpathSync(common.trim()), 'its Git directory is the common one, which is what makes it main');
  assert.notEqual(box.tryGit(directory, 'rev-parse', '--verify', 'HEAD').status, 0, 'no commit hashes the copied tree');
});

/** Install a real future transition so the running module is genuinely older than the installed declaration. */
function newerDeclaration(db) {
  const future = { ...MACHINE, moves: [...MACHINE.moves,
    { ...MACHINE.moves.find(move => move.verb === 'claim'), verb: 'future-reopen', from: ['withdrawn'], to: 'open' }] };
  for (const { name } of storeTriggers()) db.exec(`DROP TRIGGER "${name}"`);
  for (const { sql } of storeTriggers(future)) db.exec(sql);
  recordSchemaStamp(db, SCHEMA_DIGEST);
}

/** Observe the exact guards and header stamp without reopening or refreshing the board. */
function guardImage(board) {
  return {
    stamp: board.db.prepare('PRAGMA application_id').get().application_id,
    triggers: board.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_%' ORDER BY name").all(),
  };
}

test('cli.journeys-fact-board-schema.an-older-checkpoint-restore-preserves-newer: an older checkpoint restore preserves newer installed guards and reports the declaration difference [M3,A5,A6,H16]', () => {
  const diagnostics = [];
  const board = openBoard(':memory:', undefined, { onDiagnostic: text => diagnostics.push(text) });
  const source = openBoard(':memory:');
  try {
    store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Restored data under current guards' });
    // Install after opening: verification must occur under the restore transaction, not at open time.
    newerDeclaration(board.db);
    const before = guardImage(board);
    importBoard(board, exportBoard(source));
    assert.deepEqual(guardImage(board), before, 'the caller must not replace newer SQL with its own cached declaration');
    assert.equal(boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION), 'current');
    assert.equal(board.db.prepare('SELECT item_title FROM item').get().item_title, 'Restored data under current guards');
    assert.match(diagnostics.join('\n'), /preserving the installed trunk guards/u);
  } finally { store.closeBoard(board); store.closeBoard(source); }
});

test('cli.journeys-fact-board-schema.an-older-queued-undo-restores-exact: an older queued undo restores exact newer guards, including when its transaction rolls back [M3,A5,A6,H16]', () => {
  const board = openBoard(':memory:');
  try {
    const session = board.db.createSession({ table: 'shout' });
    board.db.prepare('INSERT INTO shout(shout_from,shout_to,shout_text,shout_at) VALUES(?,?,?,?)')
      .run('coordinator', 'all', 'Queued private fixture', new Date().toISOString());
    const changes = session.changeset();
    session.close();
    newerDeclaration(board.db);
    const before = guardImage(board);
    const diagnostics = [];
    board.onDiagnostic = text => diagnostics.push(text);
    assert.equal(undoQueued(board, [{ changes: [Buffer.from(changes).toString('base64')] }]), null);
    assert.equal(board.db.prepare('SELECT count(*) AS n FROM shout').get().n, 0, 'the actual queued row was undone');
    assert.deepEqual(guardImage(board), before);
    assert.equal(boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION), 'current');
    assert.match(diagnostics.join('\n'), /preserving the installed trunk guards/u);
    assert.throws(() => undoQueued(board, [{ changes: [Buffer.from('invalid SQLite changeset').toString('base64')] }]));
    assert.deepEqual(guardImage(board), before, 'failed undo rolls back both the temporary guard suspension and its data');
  } finally { store.closeBoard(board); }
});

test('cli.journeys-fact-board-schema.main-recovers-a-guard-only-downgrade: main recovers a guard-only downgrade only when the unchanged stamp attests its complete target shape [M3,A5,A6,C7]', t => {
  const file = legacyBoard(t);
  store.closeBoard(openBoard(file));
  const attested = observe(file);
  olderDeclaration(file, false);
  const drifted = observe(file);
  assert.equal(drifted.standing, 'drifted');
  assert.equal(drifted.stamp, attested.stamp);
  const readonly = store.openBoardReadOnly(file);
  readonly.close();
  store.closeBoard(openBoard(file, undefined, { isMain: false, onDiagnostic: () => {} }));
  assert.deepEqual(observe(file), drifted, 'only main may recover the previously attested declaration');
  store.closeBoard(openBoard(file));
  const recovered = observe(file);
  assert.equal(recovered.standing, 'current');
  assert.equal(recovered.stamp, attested.stamp, 'recovery must not invent a new stamp to bless drift');
  assert.deepEqual(recovered.schema, attested.schema);
  assert.deepEqual(recovered.items, attested.items);
  assert.equal(recovered.identity, attested.identity);
  assert.equal(recovered.guards.length, attested.guards.length + 1);
  const bytes = readFileSync(file);
  store.closeBoard(openBoard(file));
  assert.deepEqual(readFileSync(file), bytes, 'recovered declaration is idempotent');
});

test('cli.journeys-fact-board-schema.unrecognized-stamps-and-non-guard-drift: unrecognized stamps and non-guard drift cannot be approved by main recovery or restoration [M3,A5,A6,H16]', t => {
  const file = legacyBoard(t);
  store.closeBoard(openBoard(file));
  olderDeclaration(file, false);
  const changed = new DatabaseSync(file);
  try { changed.exec('CREATE INDEX unexpected_item_name ON item(item_title)'); }
  finally { changed.close(); }
  const before = observe(file);
  const messages = [];
  const board = openBoard(file, undefined, { onDiagnostic: text => messages.push(text) });
  const source = openBoard(':memory:');
  try {
    assert.deepEqual(observe(file), before, 'a table or index change must not be hidden by guard repair');
    assert.throws(() => importBoard(board, exportBoard(source)), error => error.code === 'IMPORT_NOT_EMPTY');
    const empty = openBoard(':memory:');
    try {
      empty.db.exec('PRAGMA application_id = 123');
      const unknown = guardImage(empty);
      assert.throws(() => importBoard(empty, exportBoard(source)), error => error.code === 'SCHEMA_DRIFT');
      assert.deepEqual(guardImage(empty), unknown, 'checkpoint restore cannot approve an unrecognized stamp');
    } finally { store.closeBoard(empty); }
    assert.throws(() => undoQueued(board, []), error => error.code === 'SCHEMA_DRIFT');
    assert.deepEqual(observe(file), before, 'refused restores leave both rows and guards unchanged');
    assert.match(messages.join('\n'), /different shape/u);
  } finally { store.closeBoard(board); store.closeBoard(source); }
});


test('cli.journeys-fact-board-schema.normal-authority-pinning-and-signed-format: normal authority pinning and signed-format restore keep a verified stamp without approving prior drift [M3,E22,H16]', () => {
  const board = openBoard(':memory:');
  const source = openBoard(':memory:');
  try {
    const authority = { version: 1, algorithm: 'Ed25519', publicKey: 'a'.repeat(43) };
    pinAuthority(board, 'https://relay.fixture', authority);
    assert.equal(boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION), 'current', 'authorized authority guards are stamped atomically');
    const guards = guardImage(board);
    importBoard(source, exportBoard(board));
    source.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run('relay_applied_sequence', '0');
    source.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run('relay_engine_version', String(ENGINE_VERSION));
    setPersonSigning(source, { agentId: 'coordinator', signed: true });
    assert.equal(boardStanding(source.db, SCHEMA_DIGEST, SCHEMA_VERSION), 'current', 'authorized signed format is stamped atomically');
    restoreRelaySnapshot(board, exportBoard(source), 0);
    assert.deepEqual(guardImage(board).triggers, guards.triggers);
    assert.equal(boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION), 'current', 'signed restore stamps only the unchanged complete SQL shape');
    assert.equal(localAuthority(board).origin, 'https://relay.fixture', 'restore retains the target authority');
    assert.equal(undoQueued(board, []), null, 'normal pinned boards remain usable for queued undo');
    board.db.exec('CREATE INDEX unexpected_signed_item ON item(item_title)');
    const badStamp = guardImage(board).stamp;
    setPersonSigning(board, { agentId: 'coordinator', signed: true });
    assert.equal(guardImage(board).stamp, badStamp, 'an authorized format operation must never bless pre-existing drift');
    assert.equal(boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION), 'drifted');
  } finally { store.closeBoard(board); store.closeBoard(source); }
});


/** Reproduce an old normal API's unchanged header using its actual pre-operation stamp. */
function legacySigningBoard(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-legacy-signing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  const board = openBoard(file);
  store.ensureGateHopTable(board.db);
  try {
    store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Keep signed legacy data' });
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run('relay_applied_sequence', '0');
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run('relay_engine_version', String(ENGINE_VERSION));
    let stamp = guardImage(board).stamp;
    const pin = () => pinAuthority(board, 'https://relay.fixture', { version: 1, algorithm: 'Ed25519', publicKey: 'a'.repeat(43) });
    if (mode === 'sign-then-pin') {
      setPersonSigning(board, { agentId: 'coordinator', signed: true });
      stamp = guardImage(board).stamp;
      pin();
    } else {
      if (mode !== 'signed-only') pin();
      if (mode === 'pin-then-sign') stamp = guardImage(board).stamp;
      if (mode !== 'pin-only') setPersonSigning(board, { agentId: 'coordinator', signed: true });
    }
    // Prior implementations performed these same normal operations but left this pre-operation header.
    board.db.exec(`PRAGMA application_id = ${stamp}`);
  } finally { store.closeBoard(board); }
  return file;
}

test('cli.journeys-fact-board-schema.main-recognizes-exact-legacy-pin-only: main recognizes exact legacy pin-only, signed-only and intermediate signed-format stamps [M3,E22,H16]', t => {
  for (const mode of ['pin-only', 'signed-only', 'both', 'pin-then-sign', 'sign-then-pin']) {
    const file = legacySigningBoard(t, mode);
    const before = observe(file);
    assert.equal(before.standing, 'drifted', mode);
    store.openBoardReadOnly(file).close();
    store.closeBoard(openBoard(file, undefined, { isMain: false, onDiagnostic: () => {} }));
    assert.deepEqual(observe(file), before, `${mode}: readers and non-main do not heal`);
    const board = openBoard(file);
    try {
      assert.equal(boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION), 'current', mode);
      assert.deepEqual(observe(file).items, before.items, `${mode}: business rows survive`);
      assert.equal(observe(file).identity, before.identity);
      assert.equal(board.db.prepare("SELECT count(*) AS n FROM event WHERE event_kind='schema-signing-recovery'").get().n, 1);
      const checkpoint = exportBoard(board);
      restoreRelaySnapshot(board, checkpoint, 0);
      assert.equal(undoQueued(board, []), null, `${mode}: restored and queued paths remain usable`);
      assert.equal(boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION), 'current');
      assert.equal(localAuthority(board)?.origin ?? null, mode === 'signed-only' ? null : 'https://relay.fixture');
    } finally { store.closeBoard(board); }
    const bytes = readFileSync(file);
    store.closeBoard(openBoard(file));
    assert.deepEqual(readFileSync(file), bytes, `${mode}: recovery is idempotent`);
  }
});

test('cli.journeys-fact-board-schema.legacy-signing-recognition-also-recovers-the: legacy signing recognition also recovers the exact attested machine declaration [M3,E22,H16]', t => {
  const file = legacySigningBoard(t, 'both');
  olderDeclaration(file, false);
  const before = observe(file);
  const board = openBoard(file);
  try {
    assert.equal(boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION), 'current');
    assert.deepEqual(observe(file).items, before.items);
    assert.equal(guardImage(board).triggers.find(row => row.name === 'machine_item_move').sql,
      storeTriggers().find(row => row.name === 'machine_item_move').sql);
  } finally { store.closeBoard(board); }
});

test('cli.journeys-fact-board-schema.legacy-pin-or-signing-recovery-never: legacy pin or signing recovery never approves missing guards, extra schema or unknown headers [M3,E22,H16]', t => {
  const damage = [
    "DROP TRIGGER person_authority_delete",
    "DROP TRIGGER person_authority_delete; CREATE TRIGGER person_authority_delete BEFORE DELETE ON board_meta BEGIN SELECT 1; END",
    "CREATE INDEX unexpected_legacy_index ON item(item_title)",
    "DROP TRIGGER machine_fields_claimed",
    "PRAGMA application_id = 123",
  ];
  for (const sql of damage) {
    const file = legacySigningBoard(t, 'both');
    const db = new DatabaseSync(file);
    try { db.exec(sql); } finally { db.close(); }
    const before = observe(file);
    const board = openBoard(file, undefined, { onDiagnostic: () => {} });
    try {
      assert.equal(boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION), 'drifted', sql);
      assert.deepEqual(observe(file), before, sql);
      assert.throws(() => undoQueued(board, []), error => error.code === 'SCHEMA_DRIFT');
      assert.deepEqual(observe(file), before, 'refusal preserves damaged evidence');
    } finally { store.closeBoard(board); }
  }
});
