/** @pullboard-module-loads packages/moves/src/logic/moves/*.js packages/moves/src/io/moves/*.js packages/moves/src/logic/table/*.table.js */
import { sourceAdvanceFloor } from "../../../verify/index.js";
import { SOURCE_ADVANCE_ENGINE } from "../../../state/light.js";
/**
 * One declaration per public board operation [C7,V4,H16]. Consumers derive their routing from these
 * files; a new move adds its own file rather than editing three registries. Leaves import only
 * constants and read-only/pure helpers, never these consumers or board.js: eager writer imports
 * would make recovery text load board writers and could cycle through this discovered registry.
 * Historical order and first-matching engine conditions belong to each leaf, not this loader.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fileSystemAdapter } from '../../../fs/index.js';

/** Load a discovered move module synchronously, so this registry (and everything that imports it) has no top-level await. */
const loadMove = createRequire(import.meta.url);
const fs = fileSystemAdapter();
import {
  MOVE_CANDIDATE,
  MOVE_FILE,
  discovered,
} from "../../../kernel/index.js";

/** The cell keeps pure moves under core/moves and effectful ones under shell/moves; both are discovered as one set. */
const MOVE_DIRECTORIES = [new URL("../logic/moves/", import.meta.url), new URL("./moves/", import.meta.url)];

/** Validate one trusted source declaration before any engine or sender uses it. */
function declarationFor(file, value) {
  const operation = file.slice(0, -'.js'.length);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.operation !== operation
      || !Number.isSafeInteger(value.engine) || value.engine < 1
      || value.order !== undefined && (!Number.isSafeInteger(value.order) || value.order < 0)
      || typeof value.itemIdFirstArgument !== 'boolean' || typeof value.minimumEngine !== 'function'
      || typeof value.actor !== 'function' || !value.nextSteps || typeof value.nextSteps !== 'object'
      || Array.isArray(value.nextSteps)
      || Object.entries(value.nextSteps).some(([code, step]) => !/^[A-Z][A-Z0-9_]*$/u.test(code) || typeof step !== 'string' || !step.trim())) {
    throw new Error(`${file} has an invalid move declaration; declare its matching operation, positive engine, item-id flag, actor, floor and recovery text`);
  }
  return Object.freeze({ ...value, order: value.order ?? Number.MAX_SAFE_INTEGER, nextSteps: Object.freeze({ ...value.nextSteps }) });
}

/** Merge shared recovery entries only when every declaration gives exactly the same bytes. */
function addSteps(target, source, owner) {
  for (const [code, step] of Object.entries(source)) {
    if (Object.hasOwn(target, code) && target[code] !== step) throw new Error(`${owner} conflicts on next step ${code}; keep one identical recovery action`);
    target[code] = step;
  }
}

/**
 * Load one discovered module beneath a folder: the single computed load in this file.
 * Why: the replay report finds move tables by name and loads them here, so the P3 scan declares one loader instead of two.
 *
 * @param {string} file a file name or relative path beneath the folder
 * @param {URL} directory the folder's URL, ending in a slash
 * @returns {Record<string, any>} the module's exports
 */
export function loadDiscovered(file, directory) {
  return loadMove(fileURLToPath(new URL(file, directory)));
}

/** The move files beneath the folders, by file name, each with its operation; reading names loads no module. */
function moveEntries(folders) {
  return (Array.isArray(folders) ? folders : [folders]).flatMap(directory => discovered(fs.list(directory), MOVE_CANDIDATE, MOVE_FILE, 'move')
    .map(file => ({ file, directory, operation: file.slice(0, -'.js'.length) })));
}

/** Order the declarations and build the registry, its operation list and merged next steps, refusing duplicates and step conflicts. */
function assembled(declarations) {
  const ordered = [...declarations].sort((a, b) => a.order - b.order || (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0));
  const registry = {};
  const nextSteps = {};
  for (const declaration of ordered) {
    if (Object.hasOwn(registry, declaration.operation)) throw new Error(`${declaration.operation} is declared twice; keep one module per operation`);
    Object.defineProperty(registry, declaration.operation, { value: declaration, enumerable: true });
    addSteps(nextSteps, declaration.nextSteps, declaration.operation);
  }
  return Object.freeze({ registry: Object.freeze(registry), operations: Object.freeze(ordered.map(declaration => declaration.operation)), nextSteps: Object.freeze(nextSteps) });
}

/**
 * Discover strict operation modules in deterministic order, also usable with isolated fixture folders.
 * New moves may omit order and append by file name; existing moves retain their historical order.
 *
 * @param {URL|URL[]} [folders] one folder, or the cell's pure and effectful move folders by default
 * @returns {{registry: Readonly<Record<string, any>>, operations: readonly string[], nextSteps: Readonly<Record<string,string>>}}
 */
export function discoverMoves(folders = MOVE_DIRECTORIES) {
  return assembled(moveEntries(folders).map(({ file, directory }) => declarationFor(file, loadDiscovered(file, directory).default)));
}

/**
 * A frozen-looking view whose target fills on first use: every trap loads the whole value, then answers from it.
 * Why: an exported array or object must keep its shape (Array.isArray, keys, order) while loading nothing until read.
 */
function filledOnUse(empty, fill) {
  let full = false;
  const target = () => {
    if (!full) { fill(empty); Object.freeze(empty); full = true; }
    return empty;
  };
  const traps = {};
  for (const name of ['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'defineProperty', 'deleteProperty', 'set', 'isExtensible', 'preventExtensions', 'getPrototypeOf', 'setPrototypeOf']) {
    traps[name] = (_, ...rest) => Reflect[name](target(), ...rest);
  }
  return new Proxy(empty, traps);
}

/**
 * The cell's moves, loaded on first use [C7]: naming one operation loads only its own module, and listing or ordering
 * them loads all of them once. Why: every command used to load all moves at startup, though most dispatch none.
 * Each declaration is validated exactly as discoverMoves does, and the ordered view equals discoverMoves' result.
 *
 * @param {URL|URL[]} [folders] one folder, or the cell's pure and effectful move folders by default
 * @returns {{registry: Readonly<Record<string, any>>, operations: readonly string[], withNextSteps: (defaults: Readonly<Record<string,string>>) => Readonly<Record<string,string>>}}
 */
export function lazyMoves(folders = MOVE_DIRECTORIES) {
  let entries, whole;
  const loaded = new Map();
  const listed = () => entries ??= moveEntries(folders);
  /** One file's validated declaration, loaded once. */
  const load = entry => {
    const key = fileURLToPath(new URL(entry.file, entry.directory));
    if (!loaded.has(key)) loaded.set(key, declarationFor(entry.file, loadDiscovered(entry.file, entry.directory).default));
    return loaded.get(key);
  };
  const all = () => whole ??= assembled(listed().map(load));
  /** One operation's declaration, loading only its own file; a name two folders share loads all, which refuses it. */
  const one = operation => {
    const found = listed().filter(entry => entry.operation === operation);
    if (found.length > 1) all();
    return found.length ? load(found[0]) : undefined;
  };
  const isMove = key => typeof key === 'string' && listed().some(entry => entry.operation === key);
  const target = {};
  /** Define one loaded operation on the target, so each reported descriptor obeys the proxy invariants. */
  const define = operation => {
    if (!Object.hasOwn(target, operation)) Object.defineProperty(target, operation, { value: one(operation), enumerable: true });
  };
  const defineAll = () => { const { operations } = all(); for (const operation of operations) define(operation); return operations; };
  const registry = new Proxy(target, {
    get: (_, key, receiver) => isMove(key) ? one(key) : Reflect.get(target, key, receiver),
    has: (_, key) => isMove(key) || Reflect.has(target, key),
    getOwnPropertyDescriptor: (_, key) => { if (isMove(key)) define(key); return Reflect.getOwnPropertyDescriptor(target, key); },
    ownKeys: () => [...defineAll()],
    preventExtensions: () => { defineAll(); return Reflect.preventExtensions(target); },
    defineProperty: () => false,
    deleteProperty: () => false,
    set: () => false,
    setPrototypeOf: () => false,
  });
  const operations = filledOnUse([], array => array.push(...all().operations));
  return Object.freeze({
    registry,
    operations,
    withNextSteps: defaults => filledOnUse({}, steps => { Object.assign(steps, defaults); addSteps(steps, all().nextSteps, 'move declarations'); }),
  });
}

const found = lazyMoves();
/** Every discovered operation declaration, in preserved historical order; one operation loads only its own module. */
export const MOVE_REGISTRY = found.registry;
/** The allowed operation names, derived rather than hand-kept. */
export const MOVE_OPERATIONS = found.operations;

/**
 * Resolve a move's existing ordered floor without interpreting a different operation's arguments.
 * The board-wide pending-condition floor is passed in by the port that composes the engine: the
 * health front door reaches this loader through its own imports, so importing it here would cycle.
 */
export function minimumMoveEngine(operation, args, board, at, boardFloor = () => 1, context) {
  if (!Object.hasOwn(MOVE_REGISTRY, operation)) throw new Error(`unknown move ${operation}; declare its own module before using it`);
  const value = MOVE_REGISTRY[operation].minimumEngine(args, board, at, context);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${operation} returned an invalid engine floor`);
  return Math.max(value, boardFloor(board), sourceAdvanceFloor(board, SOURCE_ADVANCE_ENGINE));
}

/** Unknown operations and missing argument arrays retain the original null actor. */
export function declaredMoveActor(move) {
  if (!Array.isArray(move?.args) || !Object.hasOwn(MOVE_REGISTRY, move.operation)) return null;
  return MOVE_REGISTRY[move.operation].actor(move) ?? null;
}

/** Add operation-owned next steps while refusing silent disagreements with general CLI guidance. */
export function withMoveNextSteps(defaults) {
  return found.withNextSteps(defaults);
}
