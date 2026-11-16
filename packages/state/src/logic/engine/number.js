import { ENGINE_NUMBERS } from './table.js';

/**
 * One engine leaf's number by its constant name, with no leaf module loaded and no file read [C7].
 * Why: the state doors re-exported every leaf, so each command loaded about 191 one-line modules it never ran.
 * A leaf not in the generated table is unlanded on this branch and reads as one above the highest landed engine,
 * exactly as unassignedEngine() gives it.
 *
 * @param {string} name a leaf's constant, such as BAR_ENGINE
 * @returns {number}
 */
export function engineNumber(name) {
  return ENGINE_NUMBERS[name] ?? Math.max(0, ...Object.values(ENGINE_NUMBERS)) + 1;
}
