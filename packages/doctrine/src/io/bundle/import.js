import { decodeBundle } from '../../logic/bundle/encode.js';
import { verifyBundle } from './verify.js';

/**
 * The identity of a rule: its origin board and its id, joined. Two boards may use the same rule id, so the id alone is
 * never an identity; the value is the same before and after import because it reads only those two fields [C7].
 * @param {{ originBoardId: string, id: string }} rule - A rule as a bundle carries it.
 * @returns {string}
 */
export function ruleIdentity(rule) {
  return `${rule.originBoardId}/${rule.id}`;
}

/**
 * Import a verified rule bundle: the rules keyed by origin board, then rule id, each rule unchanged.
 * Why: a bundle that fails verification must import nothing, so verification runs first and its refusal passes
 * through before any rule is decoded; origin and identity ride on each rule, so import adds nothing of its own [C7].
 * @param {{ bytes: string, digest?: string, signatures?: Array<{ key: string, signature: string }> }} bundle
 * @param {string[]} authorizedKeys - Base64 DER spki public keys the rule board authorized.
 * @returns {{ digest: string, issuer: string, revision: number, rules: Record<string, Record<string, object>> }} The rule maps have no prototype, so every accepted origin and id is an own key.
 */
export function importBundle(bundle, authorizedKeys) {
  const { digest, issuer } = verifyBundle(bundle, authorizedKeys);
  const decoded = decodeBundle(bundle.bytes);
  // Prototype-free dictionaries: an origin or rule id such as "__proto__" or "constructor" is signed data, so it must become an
  // own key of the map and never resolve to, or write through, an inherited property of Object.prototype [C7].
  const rules = Object.create(null);
  for (const rule of decoded.rules) {
    const origin = rule.originBoardId ?? decoded.originBoardId;
    (rules[origin] ??= Object.create(null))[rule.id] = { ...rule, originBoardId: origin };
  }
  return { digest, issuer, revision: decoded.revision, rules };
}
