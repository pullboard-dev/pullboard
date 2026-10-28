// @pullboard-board-file persistence: invalid ports must refuse before creating storage; migration failure must close it.
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
  return {
    ...original, nativePorts, logEvent,
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
  native.register(board, { lane: 'coordinator', path: '/private/native-root-test' });
  ports.nativePorts.atomic(board, () => ports.nativePorts.logEvent(board, 'coordinator', 'native-root-proof', null, { exact: true }));
  const event = board.db.prepare("SELECT * FROM event WHERE event_kind='native-root-proof'").get();
  assert.deepEqual(JSON.parse(event.event_detail), { exact: true, model: 'unknown' });
  assert.ok(calls.includes('one:event'));
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
  assert.throws(() => native.openBoard(file, clock, { ports: { ...ports, auth: {} } }), /auth.boardNotWritable/u);
  assert.equal(existsSync(join(directory, 'never-created')), false);
  let captured, reported = 0;
  const failure = new Error('NATIVE_MIGRATION_SENTINEL');
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
