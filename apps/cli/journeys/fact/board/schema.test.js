/** Main owns declaration upgrades; valid old stamps and manual drift remain distinct [M3,A5,A6,C7,H16]. */
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { MACHINE } from '../../../../../packages/state/index.js';
import { storeTriggers } from '../../../../../packages/state/index.js';
import { SCHEMA_DIGEST } from '../../../../../packages/store/index.js';
import { SCHEMA_VERSION } from '../../../../../packages/store/index.js';
import { boardStanding } from '../../../../../packages/store/index.js';
import { recordSchemaStamp } from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { undoQueued } from '../../../../../packages/outbox/index.js';
import { pinAuthority } from '../../../../../packages/person/index.js';
import { setPersonSigning } from '../../../../../packages/person/index.js';
import { localAuthority } from '../../../../../packages/person/index.js';
import { restoreRelaySnapshot } from '../../../../../packages/store/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Install and stamp the real previous declaration in a private fixture, without changing its data version. */
function olderDeclaration(file, stamp = true) {
  const db = new DatabaseSync(file);
  try {
    const old = storeTriggers({ ...MACHINE, moves: MACHINE.moves.filter(move => move.verb !== 'submit-merge') })
      .find(trigger => trigger.name === 'machine_item_move');
    assert.ok(!old.sql.includes("'claimed>verified'"));
    db.exec(`DROP TRIGGER machine_item_move; ${old.sql}`);
    if (stamp) recordSchemaStamp(db, SCHEMA_DIGEST);
  } finally { db.close(); }
}

/** Read persistent shape and native evidence without invoking a writable opener. */
function observe(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      standing: boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION),
      version: db.prepare('PRAGMA user_version').get().user_version,
      stamp: db.prepare('PRAGMA application_id').get().application_id,
      schema: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
      identity: db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value,
      items: db.prepare('SELECT * FROM item ORDER BY item_id').all(),
      guards: db.prepare("SELECT event_detail FROM event WHERE event_kind='guards' ORDER BY event_id").all(),
    };
  } finally { db.close(); }
}

/** Create a file-backed private board with ordinary native data and a valid legacy stamp. */
function legacyBoard(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-stamped-declaration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  const board = openBoard(file);
  try { store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Keep this row' }); }
  finally { store.closeBoard(board); }
  olderDeclaration(file);
  return file;
}

test('main refreshes a valid stamped older transition once; reads and branch opens leave it alone [M3,A5,A6,C7]', t => {
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

test('main leaves manually drifted triggers and their invalid stamp untouched [M3,A5,A6,C7]', t => {
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

/** Require a real private public command to succeed with its original diagnostics. */
async function succeeds(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.out}\n${result.err}`);
  return result;
}

/** Commit one real source change in the private Git fixture. */
function choice(box, cwd, value) {
  const result = e2e.commitFile(box, cwd, 'web/feature.js', `export const choice = '${value}';\n`, 'feat(web): fixture choice [G1]');
  assert.equal(result.status, 0, result.stderr);
  return box.git(cwd, 'rev-parse', 'HEAD');
}

test('a stamped pre-carry board upgrades on main open and completes a native merge-only submission [M3,V1,V4,H16]', async () => {
  const box = e2e.project();
  choice(box, box.repo, 'base');
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  const added = await succeeds(box, box.repo, 'add', 'web', 'Carry after declaration upgrade', '--specs', 'G1',
    '--criterion', 'The unchanged acceptance survives a trunk-only merge', '--check', 'node --check web/feature.js', '--json');
  const id = JSON.parse(added.out).item.item_id;
  await succeeds(box, box.web, 'claim', String(id));
  const accepted = choice(box, box.web, 'accepted');
  await succeeds(box, box.web, 'submit', String(id));
  box.git(box.repo, 'switch', '-q', '--detach', accepted);
  try { await succeeds(box, box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'checked the accepted choice'); }
  finally { box.git(box.repo, 'switch', '-q', 'main'); }
  choice(box, box.repo, 'trunk');
  await succeeds(box, box.repo, 'reopen', String(id), '--conflict', 'web/feature.js');
  await succeeds(box, box.web, 'claim', String(id));
  assert.notEqual(box.tryGit(box.web, 'merge', '-q', '--no-edit', 'main').status, 0);
  const head = choice(box, box.web, 'resolved');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  olderDeclaration(file);
  const before = observe(file);
  await succeeds(box, box.repo, 'status');
  assert.deepEqual(observe(file), before, 'a public main read still does not migrate declarations');
  // The ordinary E2E CLI runs this agent's unmerged source, which correctly cannot own another
  // repository's shared DDL. Copy the actual candidate into a genuine private main source checkout.
  const application = join(box.dir, 'main-application');
  mkdirSync(application);
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), application);
  box.git(application, 'init', '-q', '-b', 'main');
  box.git(application, 'add', '-A');
  box.git(application, 'commit', '-q', '-m', 'chore: candidate main source');
  // Process-level: this runs the copied candidate main checkout's own entry, which an in-process call cannot reach.
  const opened = runFixtureChild(process.execPath, [join(application, 'apps/cli/pullboard.js'), 'inbox', '--json'],
    { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr + opened.stdout);
  assert.ok(observe(file).schema.find(row => row.name === 'machine_item_move').sql.includes("'claimed>verified'"));
  await succeeds(box, box.web, 'submit', String(id));
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const item = db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
    assert.equal(item.item_status, 'verified');
    assert.equal(item.item_commit, head);
    assert.equal(db.prepare('SELECT count(*) AS n FROM verdict WHERE item_id=?').get(id).n, 1, 'carry retains the original reviewer verdict');
    assert.equal(db.prepare("SELECT count(*) AS n FROM event WHERE item_id=? AND event_kind='merge-only-accept'").get(id).n, 1);
  } finally { db.close(); }
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

test('an older checkpoint restore preserves newer installed guards and reports the declaration difference [M3,A5,A6,H16]', () => {
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

test('an older queued undo restores exact newer guards, including when its transaction rolls back [M3,A5,A6,H16]', () => {
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

test('main recovers a guard-only downgrade only when the unchanged stamp attests its complete target shape [M3,A5,A6,C7]', t => {
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

test('unrecognized stamps and non-guard drift cannot be approved by main recovery or restoration [M3,A5,A6,H16]', t => {
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


test('normal authority pinning and signed-format restore keep a verified stamp without approving prior drift [M3,E22,H16]', () => {
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

test('main recognizes exact legacy pin-only, signed-only and intermediate signed-format stamps [M3,E22,H16]', t => {
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

test('legacy signing recognition also recovers the exact attested machine declaration [M3,E22,H16]', t => {
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

test('legacy pin or signing recovery never approves missing guards, extra schema or unknown headers [M3,E22,H16]', t => {
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
