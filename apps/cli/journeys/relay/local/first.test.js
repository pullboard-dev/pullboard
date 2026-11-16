/** Local first: a linked board reads and moves locally while the sender holds the relay lock, a seat is revoked, or a move is taken back [H21,H5,H16]. */
/** @pullboard-test-input source-cell apps/cli apps/relay apps/lib store outbox */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  dirname,
  join,
} from 'node:path';
import test from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { captureBoardChanges } from '../../../../../packages/store/index.js';
import { outboxGuardFile } from '../../../../../packages/outbox/index.js';
import { undoQueued } from '../../../../../packages/outbox/index.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import {
  eventually,
  linkedBoard,
  local,
  outboxEmpty,
  senderLog,
  shoutTexts,
} from '../../../tests/fixtures/relay/local-first.js';

test('a move and a read return within a second with no network call while the sender holds the relay lock, and no read takes a lock [H21,H5,H16]', async t => {
  const { box, env } = await linkedBoard(t);
  // The sender's relay lock and the outbox guard are both held by this test process for the whole check.
  const lock = box.linkFile + '.lock';
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  t.after(() => rmSync(lock, { recursive: true, force: true }));

  for (const read of [['status'], ['list'], ['export'], ['lanes']]) await local(box, t, box.root, env, `held-${read[0]}`, read);
  const guard = new DatabaseSync(outboxGuardFile(box.linkFile));
  guard.exec('BEGIN EXCLUSIVE');
  try {
    for (const read of [['status'], ['export']]) await local(box, t, box.root, env, `guarded-${read[0]}`, read);
  } finally { guard.exec('COMMIT'); guard.close(); }

  const text = 'A move while the sender holds the relay lock';
  await local(box, t, box.root, env, 'held-move', ['shout', 'all', text]);
  const exported = await local(box, t, box.root, env, 'held-export', ['export']);
  assert.equal(shoutTexts(exported.document).filter(row => row === text).length, 1, 'the move is on the local board exactly once');
  const status = await local(box, t, box.root, env, 'held-status', ['status']);
  assert.deepEqual(status.document.relay.outbox.map(move => move.operation), ['shout'], 'status lists the move as queued for the relay');

  rmSync(lock, { recursive: true, force: true });
  const acks = box.moveAcks.length;
  await local(box, t, box.root, env, 'released-status', ['status']);
  await eventually('the sender sends the queued move once the relay lock is free', () => outboxEmpty(box) && box.moveAcks.length > acks, () => senderLog(env));
});

test('a locally known revoked seat cannot queue or apply a move and retains earlier valid outbox history [H2,H9,H21]', async t => {
  const { box, env } = await linkedBoard(t);
  const lock = box.linkFile + '.lock';
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  t.after(() => rmSync(lock, { recursive: true, force: true }));
  const text = 'A valid move queued before this seat was revoked';
  await local(box, t, box.root, env, 'before-local-revocation', ['shout', 'all', text]);
  const exported = await local(box, t, box.root, env, 'before-revocation-export', ['export']);
  const actor = exported.document.tables.shout.find(row => row.shout_text === text).shout_from;
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  // The real phone-approved revocation flow is covered in relay-agent; here its persisted marker isolates offline admission.
  state.agentTokens ??= {};
  state.agentTokens[actor] = { ...state.agentTokens[actor], revoked: true };
  writeFileSync(box.linkFile, JSON.stringify(state) + '\n', { mode: 0o600 });
  const sealed = join(dirname(box.linkFile), 'relay-outbox.sealed');
  const generation = join(dirname(box.linkFile), 'relay-outbox.generation');
  const beforeOutbox = readFileSync(sealed);
  const beforeGeneration = readFileSync(generation, 'utf8');
  const calls = box.calls.length;
  const refused = await runCliInProcess(['shout', 'all', 'A revoked seat must not create this move', '--json'], { cwd: box.root, env });
  assert.equal(refused.code, 1, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'TOKEN_REVOKED');
  assert.equal(box.calls.length, calls, 'known revocation is refused without network or token minting');
  assert.equal(readFileSync(sealed).equals(beforeOutbox), true, 'earlier valid queued moves remain byte-identical');
  assert.equal(readFileSync(generation, 'utf8'), beforeGeneration, 'a refused move never advances the outbox generation');
  const after = await local(box, t, box.root, env, 'after-revocation-export', ['export']);
  assert.deepEqual(after.document.tables, exported.document.tables, 'the refused move changes no native board row');
});

test('a queued move is taken back row for row, its item status and row counters included, so the relay\'s order replays onto the board it was made on [H21,H16]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-undo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const board = openBoard(join(directory, 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.board_ensureCoordinator(board, directory);
  store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Made before the outage' });
  const tables = ['item', 'event', 'shout', 'agent', 'board_meta', 'sqlite_sequence'];
  const image = () => JSON.stringify(tables.map(table => board.db.prepare(`SELECT * FROM ${table}`).all()));
  /** Make one move the way a local-first move is made: counters noted, rows captured. */
  const queue = async (move) => {
    const sequences = board.db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all().map(row => ({ ...row }));
    const { changes } = await captureBoardChanges(move);
    return { sequences, changes: changes.map(change => Buffer.from(change).toString('base64')) };
  };
  const ordered = image();
  const queued = [
    await queue(() => store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Added ahead of the relay' })),
    await queue(() => store.shout(board, { from: 'coordinator', to: 'all', text: 'said ahead of the relay', lanes: ['app'] })),
    await queue(() => store.withdraw(board, 1, { agentId: 'coordinator', reason: 'withdrawn ahead of the relay' })),
  ];
  assert.notEqual(image(), ordered, 'the moves show on the board at once');
  assert.equal(undoQueued(board, queued), null, 'every queued move is taken back');
  assert.equal(image(), ordered, 'the board is exactly as the relay last ordered it, counters included');
  assert.equal(store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Another machine\'s add' }), 2, 'the next number is the one the relay order gives');
  assert.equal(board.db.prepare("SELECT item_status FROM item WHERE item_id = 1").get().item_status, 'open', 'the withdrawn item is open again until its move replays');
  assert.ok(board.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine_%'").get().n > 0, 'the board keeps its lifecycle triggers');
  assert.throws(() => board.db.exec("DELETE FROM event"), /APPEND_ONLY/u, 'events are append-only again after the undo');
});
