/** @pullboard-module-loads packages/store/index.js */
/** The board's native open path: openBoard, openBoardForRead and the ports they compose, apart from the barrel so a light door can name them without loading it [C7]. */
import { createRequire } from 'node:module';
import { providers } from './providers.js';
import { openBoardForRead as readBoard } from '../../../store/light.js';
import { systemClock } from '../../../store/light.js';

const requireModule = createRequire(import.meta.url);
let store = null;
/** The store barrel, loaded on the first write open: a read-only caller never pays for the write path behind it [C7]. */
const writeStore = () => (store ??= requireModule('../../../store/index.js'));
const openBoardStore = (...args) => writeStore().openBoardStore(...args);
const requireRuntimePorts = (...args) => writeStore().requireRuntimePorts(...args);

/** Build immutable native capabilities once per connection, without a registry or cross-connection defaults. */
export function nativeBoardPorts() { return providers().nativeBoardPorts({ openBoard, openBoardForRead, draftSpecRow, decideSpecRevisions, recordRowVerification }); }

/** Freeze explicit provider bags without changing the function or canonical operation identities. */
function freezeRuntimePorts(ports) {
  requireRuntimePorts(ports);
  for (const name of ['nativePorts', 'enginePorts', 'guards', 'lifecycle', 'query', 'auth', 'sourceAdvanceReceipts', 'verification']) Object.freeze(ports[name]);
  return Object.freeze(ports);
}

/** Open the physical store with fully composed providers before migrations, guards or proof warming run. */
export function openBoard(file, clock = systemClock, { ports = nativeBoardPorts(), ...options } = {}) {
  return openBoardStore(file, clock, { ...options, ports: freezeRuntimePorts(ports) });
}

/** Serve a port bag from the connection's first read of it; a later assignment replaces it like any other property. */
function lazyPort(board, name, read) {
  Object.defineProperty(board, name, {
    enumerable: true,
    configurable: true,
    get: read,
    set(value) { Object.defineProperty(board, name, { value, enumerable: true, configurable: true, writable: true }); },
  });
}

/** Give native read consumers the same capabilities without migrating or changing the light CLI read path; the providers load when a consumer first reads a port. */
export function openBoardForRead(file, clock = systemClock, { ports = null, connection = null } = {}) {
  const board = readBoard(file, clock, { connection });
  if (!board) return board;
  let runtimePorts = null;
  const composedPorts = () => runtimePorts ??= freezeRuntimePorts(ports ?? nativeBoardPorts());
  lazyPort(board, 'runtimePorts', composedPorts);
  lazyPort(board, 'nativePorts', () => composedPorts().nativePorts);
  lazyPort(board, 'enginePorts', () => composedPorts().enginePorts);
  return board;
}

/** Execute an authenticated draft with the native composition root's explicit store ports. */
export function draftSpecRow(board, options) { return providers().applySpecRowDraft(board, options, board.nativePorts); }

/** Execute a person revision decision without changing its native engine operation shape. */
export function decideSpecRevisions(board, options) { return providers().applySpecRevisionDecisions(board, options, board.nativePorts); }

/** Record a row verdict through the same native query, transaction and event capabilities. */
export function recordRowVerification(board, options) { return providers().applyRowVerification(board, options, board.nativePorts); }
