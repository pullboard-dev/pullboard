/**
 * Refuse a new test that pins a literal where it should assert the property the literal stands for [C7,#9385,#1376].
 * Four kinds are found: an engine number (assert the engine registry instead), an exact file or case count (assert that every
 * file of the kind declares it), a file hash (assert the bytes' meaning) and a frozen JSON snapshot (assert the fields that matter).
 * A file on the approved-text allowlist may keep the kinds listed for it: those are bytes that are a contract, such as person-approved
 * text pinned by hash or data shipped to users, each with the reason.
 *
 * Why: a pinned literal fails on every honest change and says nothing about what broke, so tests assert behaviour. Behind
 * gate.literalPins, off by default: with it off the lint reads nothing and reports nothing.
 */

/** The allowlist file: per test file, the kinds it may pin and why that text is a contract, repo-relative. */
export const LITERAL_PIN_ALLOWLIST_FILE = 'packages/gate/data/literal-pins-allowlist.json';

/** The kinds of pin, each with the property to assert instead. */
export const PIN_KINDS = Object.freeze({
  engine: 'read the engine from the engine registry and assert the behaviour it gates',
  count: 'assert that every file or case of the kind declares what it must, not how many there are',
  hash: 'assert what the bytes mean; pin by hash only person-approved text, listed in the allowlist',
  snapshot: 'assert the fields that matter instead of a frozen JSON snapshot',
});

/** A count under this is a small fixed shape, not an inventory that grows. */
export const MIN_PINNED_COUNT = 10;

const TEST_FILE = /^(?:apps|packages)\/.*(?:(?:^|\/)tests?\/.*\.[cm]?js|[-_.]test\.[cm]?js)$/u;
const COMMENT = /^(?:\/\/|\/\*|\*)/u;
const ENGINE_PIN = /\bassert\.\w+\(\s*(?:[A-Z][A-Z0-9_]*_ENGINE|ENGINE_VERSION)\s*,\s*\d+|\bassert\.\w+\(\s*\d+\s*,\s*(?:[A-Z][A-Z0-9_]*_ENGINE|ENGINE_VERSION)\b/u;
const COUNT_PIN = /\bassert\.(?:equal|strictEqual)\(\s*[\w.]*(?:files?|cases?|tests?|journeys?)\w*\.(?:length|size)\s*,\s*(\d+)\s*[,)]/iu;
const SHA256 = /(['"`])[0-9a-f]{64}\1/u;
const SHA1_ASSERT = /\bassert\.\w+\(.*(?:sha|hash|digest)/iu;
const SHA1 = /(['"`])[0-9a-f]{40}\1/u;
const SNAPSHOT = /\bassert\.\w*[eE]qual\(.*JSON\.parse\(readFileSync\([^)]*(?:snapshot|frozen|golden)|toMatchSnapshot\(|\.snap\b/iu;

/** Whether a repo-relative path is a test file the lint covers. */
export const coveredByLiteralPins = path => TEST_FILE.test(path);

/**
 * The kind of pin one line holds, or null.
 *
 * @param {string} text - Source line.
 * @returns {keyof typeof PIN_KINDS | null} The kind.
 */
export function pinKindOf(text) {
  const line = text.trim();
  if (!line || COMMENT.test(line)) return null;
  if (ENGINE_PIN.test(line)) return 'engine';
  const count = COUNT_PIN.exec(line);
  if (count && Number(count[1]) >= MIN_PINNED_COUNT) return 'count';
  if (SHA256.test(line) || (SHA1_ASSERT.test(line) && SHA1.test(line))) return 'hash';
  if (SNAPSHOT.test(line)) return 'snapshot';
  return null;
}

/**
 * Findings for the pins in a set of test files: one row per pinned line naming the line, the kind and the property to assert.
 *
 * @param {Record<string, string>} files - Repo-relative path to text.
 * @param {Record<string, { kinds?: string[], reason?: string }>} [allowlist] - Files whose listed kinds (all kinds when none are listed) are contract bytes.
 * @returns {string[]} `path:line: ...` rows, sorted.
 */
export function literalPinFindings(files, allowlist = {}) {
  const rows = [];
  for (const [path, source] of Object.entries(files)) {
    if (!coveredByLiteralPins(path)) continue;
    const allowed = Object.hasOwn(allowlist, path) ? allowlist[path] : null;
    source.split('\n').forEach((text, index) => {
      const kind = pinKindOf(text);
      if (kind === null) return;
      if (allowed && (!Array.isArray(allowed.kinds) || allowed.kinds.includes(kind))) return;
      rows.push(`${path}:${index + 1}: pinned ${kind} literal; ${PIN_KINDS[kind]}`);
    });
  }
  return rows.sort();
}

/**
 * Run the lint over the source rows of a checkout. Off (the default) it reports nothing and reads nothing.
 * Why rows and text, not a root: the registry already holds the source texts and reads the allowlist, so this module imports no file system.
 *
 * @param {{file: string, source: string}[]} rows - Source files of the checkout.
 * @param {{enabled?: boolean, allowlist?: string}} [options] - `enabled` is gate.literalPins; `allowlist` is the text of the allowlist file.
 * @returns {string[]} Findings, empty when the setting is off or nothing is pinned.
 */
export function literalPinRows(rows, { enabled = false, allowlist = '{}' } = {}) {
  if (enabled !== true) return [];
  let files = {};
  try { files = JSON.parse(allowlist).files ?? {}; } catch { files = {}; }
  return literalPinFindings(Object.fromEntries(rows.map(row => [row.file, row.source])), files);
}
