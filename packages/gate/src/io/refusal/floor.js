/** A change that adds or edits a refusal code runs the declaration audit at submit, though no import reaches it [M1,V4]. */

/** The test that audits every refusal code against the machine declaration; it reads source text, so imports never reach it. */
export const REFUSAL_AUDIT_TEST = 'apps/cli/journeys/verify/machine.test.js';

const SOURCE_FILE = /^(?:packages|apps|src|bin)\/.+\.[cm]?js$/u;
const TEST_FILE = /(?:^|\/)(?:test|tests)\/|\.test\.[cm]?js$/u;
const REFUSAL_CODE = /(?:\bnew Refused\(\s*|\b(?:refuse|code)\s*:\s*)(['"`])([A-Z][A-Z0-9_]{2,})\1/gu;

/**
 * Every refusal code a source text raises or declares.
 *
 * @param {string | null} source
 * @returns {Set<string>}
 */
export function refusalCodes(source) {
  return new Set([...String(source ?? '').matchAll(REFUSAL_CODE)].map(match => match[2]));
}

/**
 * The audit test a change must run at submit: it is named when any changed source file adds or removes a refusal code,
 * and only when the manifest holds it, so a diff that touches no code never adds it.
 *
 * @param {{ changed: string[] | null, manifest: { files: { file: string }[] }, read: (file: string, side: 'base' | 'head') => string | null }} input
 * @returns {string[]} the audit test, or none
 */
export function refusalFloor({ changed, manifest, read }) {
  if (!changed?.length || !manifest.files.some(row => row.file === REFUSAL_AUDIT_TEST)) return [];
  for (const file of changed) {
    if (!SOURCE_FILE.test(file) || TEST_FILE.test(file)) continue;
    const before = refusalCodes(read(file, 'base')), after = refusalCodes(read(file, 'head'));
    if ([...after].some(code => !before.has(code)) || [...before].some(code => !after.has(code))) return [REFUSAL_AUDIT_TEST];
  }
  return [];
}
