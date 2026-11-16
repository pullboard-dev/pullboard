/** Content hashes of the test files a bar names, frozen at claim so a builder cannot rewrite its own proof [C7,V4]. */
import { createHash } from 'node:crypto';
import { Refused } from '../../../kernel/index.js';
import { barTestFiles } from './frozen.js';

/** The test-hash ruling text a person records: `test-hash <path> <sha256 of the new content>`. */
const RULING = /^test-hash (\S+) ([a-f0-9]{64})$/u;

/** SHA-256 of a file's text; null stands for a file that does not exist. */
export function contentHash(text) { return text == null ? null : createHash('sha256').update(text).digest('hex'); }

/**
 * Hashes of the test files the criterion names that already exist where `read` looks.
 * Why: a clause naming an existing test freezes its content; a file the builder creates later is not frozen, since
 * it did not exist when the bar was set.
 *
 * @param {{ item_frozen?: string, item_criterion?: string, item_brief?: string }} item
 * @param {(path: string) => string | null} read content of a path at the accepted main, or null when absent
 * @param {Record<string, string>} [kept] hashes already frozen, which stay as they were
 * @returns {Record<string, string>} path to sha256, sorted by path
 */
export function namedTestHashes(item, read, kept = {}) {
  const out = {};
  for (const path of [...barTestFiles(item).criterion].sort()) {
    const hash = Object.hasOwn(kept, path) ? kept[path] : contentHash(read(path));
    if (hash) out[path] = hash;
  }
  return out;
}

/** The hashes a frozen bar carries, or an empty map for a bar frozen before they were recorded. */
export function frozenTestHashes(item) {
  try {
    const hashes = JSON.parse(item?.item_frozen ?? 'null')?.testHashes;
    return hashes && typeof hashes === 'object' && !Array.isArray(hashes) ? hashes : {};
  } catch { return {}; }
}

/** Test-hash rulings recorded by the person on an item's thread: `[{ path, hash, factId }]`. */
export function testHashRulings(thread, person) {
  return thread.filter(entry => entry.type === 'fact' && entry.kind === 'decision' && entry.by === person)
    .map(entry => ({ match: RULING.exec(String(entry.text).trim()), factId: entry.id }))
    .filter(entry => entry.match).map(entry => ({ path: entry.match[1], hash: entry.match[2], factId: entry.factId }));
}

/**
 * The files whose content at the submitted head differs from the frozen hash because of the builder's own change.
 * A file that equals accepted main is main's change merged in, never the builder's, so it passes.
 *
 * @param {Record<string, string>} frozen
 * @param {(path: string) => string | null} atHead
 * @param {(path: string) => string | null} atMain
 * @returns {{ path: string, was: string, now: string | null }[]}
 */
export function changedTestFiles(frozen, atHead, atMain) {
  return Object.entries(frozen).flatMap(([path, was]) => {
    const now = contentHash(atHead(path));
    return now === was || now === contentHash(atMain(path)) ? [] : [{ path, was, now }];
  });
}

/**
 * The refusal for a submit that changed a frozen test file without a person's ruling, or null.
 *
 * @param {{ item_id: number, item_frozen?: string }} item
 * @param {any[]} thread the item's thread
 * @param {{ atHead: (path: string) => string | null, atMain: (path: string) => string | null, person: string }} source
 * @returns {Refused | null}
 */
export function testHashProblem(item, thread, { atHead, atMain, person }) {
  const rulings = testHashRulings(thread, person);
  const open = changedTestFiles(frozenTestHashes(item), atHead, atMain)
    .filter(change => !rulings.some(ruling => ruling.path === change.path && ruling.hash === change.now));
  if (!open.length) return null;
  const list = open.map(change => `${change.path} (frozen ${change.was.slice(0, 12)}, now ${change.now ? change.now.slice(0, 12) : 'deleted'})`).join(', ');
  const first = open[0];
  return new Refused('TEST_HASH_CHANGED', `#${item.item_id} changed a test file its bar froze at claim: ${list}`,
    `restore ${first.path} to the frozen content, or ask the coordinator to bring the change to the person for a ruling: pullboard fact ${item.item_id} decision "test-hash ${first.path} ${first.now ?? '<sha256>'}" --as person`);
}

/** The test-hash refusal, only when verify.frozenTests is true (off by default); hashes are recorded either way [C7]. */
export function frozenTestsProblem(verify, item, thread, source) {
  return verify?.frozenTests === true ? testHashProblem(item, thread, source) : null;
}

/** The author record a submit writes for a test file: `test author <path>: seat <id>, family <name>, sha256 <hash>`. */
const AUTHOR = /^test author (\S+): seat (\S+), family (.+), sha256 ([a-f0-9]{64})$/u;

/** The newest author record per test file on an item's thread: `{ path: { seat, family, hash, factId } }`. */
export function testAuthors(thread) {
  const out = {};
  for (const entry of thread) {
    const match = entry.type === 'fact' && entry.kind === 'note' ? AUTHOR.exec(String(entry.text).trim()) : null;
    if (match) out[match[1]] = { seat: match[2], family: match[3], hash: match[4], factId: entry.id };
  }
  return out;
}

/**
 * The author notes a submit records: one per test file its bar names that the submitted head added or changed against accepted main.
 * Why: the builder seat and model family of each test are the data a separate-test-author mode needs [C7,V4].
 *
 * @param {{ item_frozen?: string, item_criterion?: string }} item
 * @param {any[]} thread the item's thread, so a file whose newest record already has this content is not recorded twice
 * @param {{ atHead: (path: string) => string | null, atMain: (path: string) => string | null, seat: string, family: string | null }} source
 * @returns {string[]} note texts
 */
export function testAuthorNotes(item, thread, { atHead, atMain, seat, family }) {
  const known = testAuthors(thread);
  return barTestFiles(item).criterion.sort().flatMap(path => {
    const hash = contentHash(atHead(path));
    return hash && hash !== contentHash(atMain(path)) && known[path]?.hash !== hash
      ? [`test author ${path}: seat ${seat}, family ${family || 'unknown'}, sha256 ${hash}`] : [];
  });
}

/**
 * The refusal for a submit whose own seat wrote a bar-named test file, only when verify.testAuthorSplit is true (off by default).
 * Why: under the split a separate seat writes the tests and the builder implements against them, so a test the builder
 * changed passes only when another seat is recorded as its author at the same content [C7,V4].
 *
 * @param {{ testAuthorSplit?: boolean } | undefined} verify
 * @param {{ item_id: number, item_criterion?: string }} item
 * @param {any[]} thread the item's thread, read for `test author` records
 * @param {{ atHead: (path: string) => string | null, atMain: (path: string) => string | null, seat: string }} source
 * @returns {Refused | null}
 */
export function authorSplitProblem(verify, item, thread, { atHead, atMain, seat }) {
  if (verify?.testAuthorSplit !== true) return null;
  const known = testAuthors(thread);
  const own = [...barTestFiles(item).criterion].sort().filter(path => {
    const hash = contentHash(atHead(path));
    return hash && hash !== contentHash(atMain(path)) && !(known[path]?.hash === hash && known[path].seat !== seat);
  });
  if (!own.length) return null;
  return new Refused('TEST_AUTHOR_SAME_SEAT', `#${item.item_id} changed a bar-named test file that no other seat authored: ${own.join(', ')}`,
    `restore ${own[0]} to accepted main and build against the test as written, or have another seat write it and record itself as the author`);
}
