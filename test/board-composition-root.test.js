/** Native construction binds all capabilities before guards and preserves the public board API [C7,B1,B2]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as native from '../src/native-board.js';
import * as legacy from '../src/board.js';
import { board as library } from '../src/index.js';
import { fixtureBoard } from './board-fixture.js';
import { openBoardStore } from '../src/board-store.js';
import { recordRowDraft } from '../src/row-draft-store.js';

test('native spec operations retain their public identity and explicit draft providers fail before mutation [C7,S1,D1]', t => {
  for (const name of ['draftSpecRow', 'decideSpecRevisions', 'recordRowVerification']) {
    assert.equal(legacy[name], native[name], 'the public board API names the one native operation definition');
  }
  const board = fixtureBoard(t);
  const agentId = legacy.register(board, { lane: 'core', path: '/fixture/spec-port-author' });
  const options = { agentId, row: { id: 'G1', text: 'Keep the exact native draft.', gate: 'review', tier: 'must', section: 'G' } };
  const before = legacy.events(board);
  const refusal = new Error('owned fixture draft provider refused');
  let reads = 0;
  const ports = { ...board.nativePorts,
    /** Refuse the supplied read at the real atomic boundary; no hidden default may replace it. */
    rowDrafts() { reads++; throw refusal; },
  };
  assert.throws(() => recordRowDraft(board, options, ports), error => error === refusal);
  assert.equal(reads, 1);
  assert.deepEqual(legacy.events(board), before, 'a refused provider appends no native event');
  assert.deepEqual(legacy.rowDrafts(board), [], 'a refused provider reserves no row identity');
  const draft = legacy.draftSpecRow(board, options);
  assert.equal(draft.id, 'G1');
  assert.equal(draft.text, options.row.text);
  assert.equal(draft.by, agentId);
  assert.equal(legacy.events(board).at(-1).event_kind, 'row_draft');
  const after = legacy.events(board);
  assert.deepEqual(legacy.draftSpecRow(board, options), draft, 'the native wrapper keeps the existing exact-draft idempotency');
  assert.deepEqual(legacy.events(board), after, 'an unchanged native draft records no second event');
});

/** Wrap actual providers so migration observes per-connection bindings before its first callback. */
function observedPorts(label, calls) {
  const original = native.nativeBoardPorts();
  /** Retain the actual transaction while observing the initial connection's capabilities. */
  function atomic(board, work) {
    assert.equal(board.nativePorts.atomic, atomic);
    assert.equal(board.enginePorts, original.enginePorts);
    calls.push(label + ':atomic');
    return original.nativePorts.atomic(board, work);
  }
  /** Retain the native writer and its signed append-only event behavior. */
  function logEvent(...args) {
    calls.push(label + ':event');
    return original.logEvent(...args);
  }
  const nativePorts = { ...original.nativePorts, atomic, logEvent };
  const verification = { ...original.verification,
    /** Observe actual Rigor warming through this connection's explicit capability. */
    ensureRigorCounters(board, ...args) {
      assert.equal(board.runtimePorts.verification, verification);
      assert.ok(Object.isFrozen(verification));
      calls.push(label + ':rigor-warm');
      return original.verification.ensureRigorCounters(board, ...args);
    },
    /** Observe actual event projection without changing the provider's arguments. */
    appendRigorCounter(board, ...args) {
      assert.equal(board.runtimePorts.verification, verification);
      calls.push(label + ':rigor-append');
      return original.verification.appendRigorCounter(board, ...args);
    },
  };
  return {
    ...original, nativePorts, logEvent, verification,
    guards: { ...original.guards,
      /** Migration guards must see the final native and engine bags before returning the connection. */
      guardStore(board) {
        assert.equal(board.nativePorts, nativePorts);
        calls.push(label + ':guards');
        return original.guards.guardStore(board);
      },
    },
    lifecycle: { ...original.lifecycle, atomic,
      /** Proof warming runs on the same connection-local providers as every migration callback. */
      ensureProofCounters(board) {
        assert.equal(board.nativePorts, nativePorts);
        calls.push(label + ':proof');
        return original.lifecycle.ensureProofCounters(board);
      },
    },
  };
}

test('the single native root supplies every port before migration and keeps legacy/library/fixture entry points [C7,B1,B2]', t => {
  assert.equal(legacy.openBoard, native.openBoard);
  assert.equal(library.openBoard, native.openBoard);
  assert.equal(library, legacy, 'the complete existing module namespace remains the library surface');
  const calls = [], ports = observedPorts('one', calls);
  const board = native.openBoard(':memory:', undefined, { ports });
  t.after(() => native.closeBoard(board));
  assert.equal(board.runtimePorts, ports);
  for (const name of ['guards', 'operations', 'logEvent', 'query', 'auth']) assert.ok(board.runtimePorts[name], name);
  assert.equal(board.nativePorts, ports.nativePorts);
  assert.equal(board.enginePorts, ports.enginePorts);
  assert.ok(Object.isFrozen(board.nativePorts));
  assert.ok(Object.isFrozen(board.enginePorts));
  assert.ok(calls.includes('one:guards'));
  assert.ok(calls.includes('one:proof'));
  assert.ok(calls.includes('one:rigor-warm'));
  native.board.register(board, { lane: 'coordinator', path: '/private/native-root-test' });
  ports.nativePorts.atomic(board, () => ports.nativePorts.logEvent(board, 'coordinator', 'native-root-proof', null, { exact: true }));
  const event = board.db.prepare("SELECT * FROM event WHERE event_kind='native-root-proof'").get();
  assert.deepEqual(JSON.parse(event.event_detail), { exact: true, model: 'unknown' });
  assert.ok(calls.includes('one:event'));
  assert.ok(calls.includes('one:rigor-append'));
  const fixture = fixtureBoard(t);
  assert.ok(fixture.nativePorts);
  assert.equal(fixture.enginePorts.store.openBoard, native.openBoard);
});

test('two native connections retain isolated providers and clocks without registration side effects [C7,B1]', t => {
  const calls = [];
  const first = native.openBoard(':memory:', { now: () => new Date('2026-01-01T00:00:00Z') }, { ports: observedPorts('a', calls) });
  const second = native.openBoard(':memory:', { now: () => new Date('2026-02-01T00:00:00Z') }, { ports: observedPorts('b', calls) });
  t.after(() => { native.closeBoard(first); native.closeBoard(second); });
  const before = calls.length;
  first.nativePorts.atomic(first, () => {});
  assert.deepEqual(calls.slice(before), ['a:atomic']);
  assert.equal(first.nativePorts.now(first), '2026-01-01T00:00:00.000Z');
  assert.equal(second.nativePorts.now(second), '2026-02-01T00:00:00.000Z');
  assert.notEqual(first.nativePorts, second.nativePorts);
});

test('raw storage refuses absent providers before filesystem effects and closes a failed migration [C7,B1]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-native-root-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const clock = { now: () => new Date() };
  assert.throws(() => openBoardStore(file, clock), /explicit runtime ports/u);
  assert.equal(existsSync(join(directory, 'never-created')), false);
  const ports = native.nativeBoardPorts();
  // @pullboard-board-file persistence: missing auth must refuse before creating the database directory.
  assert.throws(() => native.openBoard(file, clock, { ports: { ...ports, auth: {} } }), /auth.boardNotWritable/u);
  assert.equal(existsSync(join(directory, 'never-created')), false);
  let captured, reported = 0;
  const failure = new Error('NATIVE_MIGRATION_SENTINEL');
  /** Capture the actual connection so failed migration cleanup can be observed. */
  const atomic = (board, work) => { captured = board; return ports.nativePorts.atomic(board, work); };
  const broken = { ...ports,
    nativePorts: { ...ports.nativePorts, atomic },
    lifecycle: { ...ports.lifecycle, atomic },
    query: { ...ports.query, migrate() { throw failure; } },
    auth: { ...ports.auth, boardNotWritable(file, error) { reported++; return ports.auth.boardNotWritable(file, error); } },
  };
  assert.throws(() => native.openBoard(':memory:', clock, { ports: broken }), error => error === failure);
  assert.equal(reported, 1);
  assert.throws(() => captured.db.prepare('SELECT 1'), /closed|not open/u);
});


test('incomplete engine capabilities refuse before storage exists [C7,B1]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-engine-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts();
  for (const key of ['store', 'registry', 'sealSourceAdvance']) {
    const enginePorts = { ...ports.enginePorts };
    delete enginePorts[key];
    assert.throws(() => {
      // @pullboard-board-file persistence: incomplete engine capabilities must refuse before storage exists.
      const board = native.openBoard(file, undefined, { ports: { ...ports, enginePorts } });
      native.closeBoard(board);
    }, error => error.code === 'NO_POLICY' && error.message.includes(`enginePorts.${key}`));
    assert.equal(existsSync(join(directory, 'never-created')), false);
  }
});

test('missing native person identity refuses before storage exists [C7,B1]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-person-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts();
  const nativePorts = { ...ports.nativePorts };
  delete nativePorts.PERSON;
  assert.throws(() => {
    // @pullboard-board-file persistence: absent native identity must refuse before storage exists.
    const board = native.openBoard(file, undefined, { ports: { ...ports, nativePorts } });
    native.closeBoard(board);
  }, error => error.code === 'NO_POLICY' && error.message.includes('nativePorts.PERSON'));
  assert.equal(existsSync(join(directory, 'never-created')), false);
});

test('native read wrappers carry explicit capabilities while SQLite remains read-only and schema-preserving [C7,A5,A6]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-native-read-'));
  const file = join(directory, 'board.sqlite');
  let read;
  t.after(() => { try { if (read) native.closeBoard(read); } finally { rmSync(directory, { recursive: true, force: true }); } });
  // @pullboard-board-file persistence: read-only reopening must preserve the actual SQLite schema and deny writes.
  const written = native.openBoard(file);
  native.closeBoard(written);
  const ports = native.nativeBoardPorts();
  read = native.openBoardForRead(file, undefined, { ports });
  assert.equal(read.readOnly, true);
  assert.equal(read.nativePorts, ports.nativePorts);
  assert.equal(read.enginePorts, ports.enginePorts);
  assert.deepEqual(read.nativePorts.rowDrafts(read), []);
  assert.throws(() => read.db.exec('CREATE TABLE forbidden (id INTEGER)'), /readonly|read.only/u);
  assert.equal(read.db.prepare("SELECT name FROM sqlite_master WHERE name='forbidden'").get(), undefined);
  assert.equal(native.openBoardForRead(join(directory, 'absent.sqlite')), null);
  assert.equal(legacy.openBoardForRead, native.openBoardForRead);
});


test('source advance receipt capabilities are frozen and refuse missing members before storage exists [C7,B1]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-source-receipts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts();
  assert.equal(Object.isFrozen(ports.sourceAdvanceReceipts), true);
  for (const key of ['boardReceiptStore', 'readGateReceipt', 'receiptBody']) {
    const sourceAdvanceReceipts = { ...ports.sourceAdvanceReceipts };
    delete sourceAdvanceReceipts[key];
    assert.throws(() => {
      // @pullboard-board-file persistence: absent receipt authority refuses before SQLite or its directory exists.
      const board = native.openBoard(file, undefined, { ports: { ...ports, sourceAdvanceReceipts } });
      native.closeBoard(board);
    }, error => error.code === 'NO_POLICY' && error.message.includes(`sourceAdvanceReceipts.${key}`));
    assert.equal(existsSync(join(directory, 'never-created')), false);
  }
});

test('every verification capability is required before storage exists [C7,B1,B2]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-verification-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts();
  for (const key of Object.keys(ports.verification)) {
    const verification = { ...ports.verification };
    delete verification[key];
    assert.throws(() => {
      // @pullboard-board-file persistence: absent verification capabilities refuse before creating storage.
      const board = native.openBoard(file, undefined, { ports: { ...ports, verification } });
      native.closeBoard(board);
    }, error => error.code === 'NO_POLICY' && error.message.includes(`verification.${key}`));
    assert.equal(existsSync(join(directory, 'never-created')), false);
  }
});
