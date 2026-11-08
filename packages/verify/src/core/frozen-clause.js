/** Normalize presentation whitespace without changing the quoted requirement's wording. */
export function wording(value) { return String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' '); }

/** Extract semantic bar content, excluding a policy commit that can change during ordinary rebases. */
export function frozenBar(item) {
  let frozen;
  try { frozen = JSON.parse(item.item_frozen); }
  catch { return { criterion: wording(item.item_frozen), rows: [], check: '' }; }
  if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen)) {
    return { criterion: wording(item.item_frozen), rows: [], check: '' };
  }
  return { criterion: wording(frozen.criterion), check: wording(frozen.check),
    rows: Array.isArray(frozen.rows) ? frozen.rows.map(row => ({ id: row.id, text: wording(row.text) })) : [] };
}

/** A gate that names one JavaScript test file, as opposed to a command or a prose description. */
const GATE_FILE = /^(?:\.\/)?[\w@][\w@./-]*\.[cm]?js$/u;

/**
 * Each frozen spec row whose gate names one test file: `[{ id, file }]`.
 * Why: reviewers rejected green gates because a cited row's clause had no named run of its gate test (5 Nov, C7 and
 * test/ci.test.js); submit runs these files and the review packet cites them for their row [V4].
 *
 * @param {{ item_frozen?: string }} item
 * @returns {{ id: string, file: string }[]}
 */
export function frozenRowGates(item) {
  let frozen;
  try { frozen = JSON.parse(item?.item_frozen ?? 'null'); } catch { return []; }
  if (!Array.isArray(frozen?.rows)) return [];
  return frozen.rows.map(row => ({ id: String(row?.id ?? ''), file: wording(row?.gate).replace(/^\.\//u, '') }))
    .filter(row => row.id && GATE_FILE.test(row.file));
}

/** A repository test-file path inside prose: `*.test.js` or `*.spec.js`, also .mjs and .cjs. */
const TEST_PATH = /[\w@][\w@./-]*\.(?:test|spec)\.[cm]?js\b/gu;

/**
 * The test files an item's bar names, in order: those in its frozen criterion, then those its brief lists under `Test:`.
 * Why: seal and tier selection pick tests by changed cells, so a clause naming test/git-adapter.test.js had no recorded
 * run when the change sat in another cell (7 of 31 INSUFFICIENT_EVIDENCE rejects on 7 Nov). Submit runs these files with
 * the proof whatever the selection says, and the review packet cites their outcomes per clause [V4,C7].
 *
 * @param {{ item_frozen?: string, item_criterion?: string, item_brief?: string }} item
 * @returns {{ criterion: string[], brief: string[], all: string[] }} Repo-relative paths, without a leading `./`.
 */
export function barTestFiles(item) {
  const paths = text => [...new Set([...String(text).matchAll(TEST_PATH)].map(match => match[0].replace(/^\.\//u, '')))];
  const criterion = paths(frozenBar(item ?? {}).criterion || wording(item?.item_criterion));
  const brief = paths(/(?:^|\n)Test:([\s\S]*)$/u.exec(String(item?.item_brief ?? ''))?.[1] ?? '');
  return { criterion, brief, all: [...new Set([...criterion, ...brief])] };
}

/** Resolve an unambiguous quotation to its containing requirement, so shorter quotes cannot reset a round. */
export function namedClause(bar, quote, includeCheck = false) {
  const texts = [...new Set([bar.criterion, ...(includeCheck ? [bar.check] : []), ...bar.rows.map(row => row.text)]
    .flatMap(text => [text, ...text.split(/(?<=[.!?])\s+/u)])
    .filter(text => text && text.includes(quote)))];
  const clauses = texts.filter(text => !texts.some(other => other !== text && text.includes(other)));
  return clauses.length === 1 ? clauses[0] : null;
}

