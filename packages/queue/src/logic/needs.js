import { Refused } from '../../../kernel/browser.js';

/** What an item may need and an agent may be able to do [U136,C7,#1888]. */
export const NEEDS = Object.freeze(['browser', 'gui']);

/**
 * The needs an agent lacks: each need not among its abilities, in the order the item lists them.
 * Why: next hands an agent only work it can do, so a lacking need is what keeps an item from it.
 * @param {string[]} needs
 * @param {string[]} abilities
 */
export function missingNeeds(needs, abilities) {
  const has = new Set(abilities ?? []);
  return (needs ?? []).filter(need => !has.has(need));
}

/**
 * The needs list, unchanged, when every name is one the board knows.
 * Why: a misspelt need would never be met by any agent and would strand the item silently.
 * @param {string[]} list
 */
export function validateNeeds(list) {
  const unknown = (list ?? []).filter(need => !NEEDS.includes(need));
  if (unknown.length) throw new Refused('USAGE', `needs are ${NEEDS.join(' and ')}, not ${unknown.join(', ')}`);
  return list;
}
