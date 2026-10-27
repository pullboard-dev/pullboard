/** @pullboard-module-loads src/moves/*.js */
/**
 * One declaration per public board operation [C7,V4,H16]. Consumers derive their routing from these
 * files; a new move adds its own file rather than editing three registries. Leaves import only
 * constants and read-only/pure helpers, never these consumers or board.js: eager writer imports
 * would make recovery text load board writers and could cycle through this discovered registry.
 * Historical order and first-matching engine conditions belong to each leaf, not this loader.
 */
import { conditionalHoldFloor } from './stale-state-floor.js';
import { readdirSync } from 'node:fs';
import {
  MOVE_CANDIDATE,
  MOVE_FILE,
  discovered,
} from './discovery.js';

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
 * Discover strict operation modules in deterministic order, also usable with isolated fixture folders.
 * New moves may omit order and append by file name; existing moves retain their historical order.
 *
 * @param {URL} [directory]
 * @returns {Promise<{registry: Readonly<Record<string, any>>, operations: readonly string[], nextSteps: Readonly<Record<string,string>>}>}
 */
export async function discoverMoves(directory = new URL('./moves/', import.meta.url)) {
  const files = discovered(readdirSync(directory), MOVE_CANDIDATE, MOVE_FILE, 'move');
  const declarations = await Promise.all(files.map(async file => declarationFor(file, (await import(new URL(file, directory).href)).default)));
  declarations.sort((a, b) => a.order - b.order || (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0));
  const registry = {};
  const nextSteps = {};
  for (const declaration of declarations) {
    if (Object.hasOwn(registry, declaration.operation)) throw new Error(`${declaration.operation} is declared twice; keep one module per operation`);
    Object.defineProperty(registry, declaration.operation, { value: declaration, enumerable: true });
    addSteps(nextSteps, declaration.nextSteps, declaration.operation);
  }
  return Object.freeze({ registry: Object.freeze(registry), operations: Object.freeze(declarations.map(declaration => declaration.operation)), nextSteps: Object.freeze(nextSteps) });
}

const found = await discoverMoves();
/** Every discovered operation declaration, in preserved historical order. */
export const MOVE_REGISTRY = found.registry;
/** The allowed operation names, derived rather than hand-kept. */
export const MOVE_OPERATIONS = found.operations;

/** Resolve a move's existing ordered floor without interpreting a different operation's arguments. */
export function minimumMoveEngine(operation, args, board, at) {
  if (!Object.hasOwn(MOVE_REGISTRY, operation)) throw new Error(`unknown move ${operation}; declare its own module before using it`);
  const value = MOVE_REGISTRY[operation].minimumEngine(args, board, at);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${operation} returned an invalid engine floor`);
  return Math.max(value, conditionalHoldFloor(board));
}

/** Unknown operations and missing argument arrays retain the original null actor. */
export function declaredMoveActor(move) {
  if (!Array.isArray(move?.args) || !Object.hasOwn(MOVE_REGISTRY, move.operation)) return null;
  return MOVE_REGISTRY[move.operation].actor(move) ?? null;
}

/** Add operation-owned next steps while refusing silent disagreements with general CLI guidance. */
export function withMoveNextSteps(defaults) {
  const nextSteps = { ...defaults };
  addSteps(nextSteps, found.nextSteps, 'move declarations');
  return Object.freeze(nextSteps);
}
