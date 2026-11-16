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
 * @returns {{ digest: string, issuer: string, revision: number, rules: Record<string, Record<string, object>> }}
 */
export function importBundle(bundle, authorizedKeys) {
  const { digest, issuer } = verifyBundle(bundle, authorizedKeys);
  const decoded = decodeBundle(bundle.bytes);
  const rules = {};
  for (const rule of decoded.rules) {
    const origin = rule.originBoardId ?? decoded.originBoardId;
    (rules[origin] ??= {})[rule.id] = { ...rule, originBoardId: origin };
  }
  return { digest, issuer, revision: decoded.revision, rules };
}
