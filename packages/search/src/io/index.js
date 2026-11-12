/** The search sidecar: a TF-IDF index over every item's title, criterion and brief, derived from the board and safe to delete [C7]. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { listItems } from '../../../store/light.js';
import { buildIndex } from '../logic/tfidf.js';
import { indexFromJson } from '../logic/tfidf.js';
import { indexToJson } from '../logic/tfidf.js';
import { itemText } from '../logic/tfidf.js';
import { rank } from '../logic/tfidf.js';
import { tokens } from '../logic/tfidf.js';
import { vectorize } from '../logic/tfidf.js';

/** The sidecar format; a sidecar of another version is rebuilt, never read. */
export const SEARCH_SIDECAR_VERSION = 1;

/**
 * Every board item as a search document, in id order, with a digest of the whole corpus.
 * Why: the digest tells a reader whether the sidecar still matches the board without trusting file times.
 *
 * @param {object} board - An open board.
 * @returns {{ docs: { id: number, text: string }[], digest: string }}
 */
export function boardDocuments(board) {
  const docs = listItems(board, { all: true })
    .map(item => ({ id: item.item_id, text: itemText({ title: item.item_title, criterion: item.item_criterion, brief: item.item_brief }) }))
    .sort((a, b) => a.id - b.id);
  return { docs, digest: createHash('sha256').update(JSON.stringify(docs)).digest('hex') };
}

/**
 * Build the index from the board and write it to the sidecar file, replacing any earlier one whole.
 *
 * @param {object} board - An open board.
 * @param {{ sidecar: string }} options - The sidecar file path.
 * @returns {{ ids: number[], idf: Map<string, number>, vectors: Map<string, number>[], digest: string }}
 */
export function buildSearchIndex(board, { sidecar }) {
  const { docs, digest } = boardDocuments(board);
  const index = buildIndex(docs);
  mkdirSync(dirname(sidecar), { recursive: true });
  const temporary = `${sidecar}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: SEARCH_SIDECAR_VERSION, digest, ...indexToJson(index) }) + '\n');
  renameSync(temporary, sidecar);
  return { ...index, digest };
}

/**
 * Read the sidecar, or null when it is missing, unreadable or of another version.
 *
 * @param {string} sidecar
 * @returns {{ ids: number[], idf: Map<string, number>, vectors: Map<string, number>[], digest: string } | null}
 */
export function readSearchIndex(sidecar) {
  if (!existsSync(sidecar)) return null;
  try {
    const data = JSON.parse(readFileSync(sidecar, 'utf8'));
    if (data?.version !== SEARCH_SIDECAR_VERSION) return null;
    return { ...indexFromJson(data), digest: data.digest };
  } catch { return null; }
}

/**
 * The index for the board as it is now: the sidecar when it matches the board, else a fresh build that replaces it.
 *
 * @param {object} board - An open board.
 * @param {{ sidecar: string }} options
 * @returns {{ ids: number[], idf: Map<string, number>, vectors: Map<string, number>[], digest: string }}
 */
export function searchIndex(board, { sidecar }) {
  const stored = readSearchIndex(sidecar);
  if (stored && stored.digest === boardDocuments(board).digest) return stored;
  return buildSearchIndex(board, { sidecar });
}

/**
 * The board items most like a text, best first.
 *
 * @param {object} board - An open board.
 * @param {string} text - Query text, such as a new item's title, criterion and brief.
 * @param {{ sidecar: string, limit?: number, exclude?: number[] }} options
 * @returns {{ id: number, score: number }[]}
 */
export function searchItems(board, text, { sidecar, limit, exclude } = {}) {
  return rank(searchIndex(board, { sidecar }), text, { limit, exclude });
}

/** Item states that are finished; a related-items block never lists them. */
const CLOSED = ['verified', 'withdrawn'];

/** How many items may be missing from the sidecar before an add-time lookup rebuilds it instead of reading it as it is. */
const STALE_ITEMS = 20;

/**
 * Each hit with its item's state and title, read by id so a lookup never loads the whole board.
 *
 * @param {object} board
 * @param {{ id: number, score: number }[]} hits
 * @returns {{ id: number, score: number, state: string, title: string }[]}
 */
function describe(board, hits) {
  if (!hits.length) return [];
  const rows = board.db.prepare(`SELECT item_id AS id, item_status AS state, item_title AS title FROM item WHERE item_id IN (${hits.map(() => '?').join(',')})`).all(...hits.map(hit => hit.id));
  const byId = new Map(rows.map(row => [row.id, row]));
  return hits.map(hit => ({ id: hit.id, score: hit.score, state: byId.get(hit.id)?.state ?? 'unknown', title: byId.get(hit.id)?.title ?? '' }));
}

/**
 * The best matches for a text with each item's state and title, for a person to read.
 *
 * @param {object} board - An open board.
 * @param {string} text
 * @param {{ sidecar: string, limit?: number, exclude?: number[] }} options
 * @returns {{ id: number, score: number, state: string, title: string }[]}
 */
export function searchItemRows(board, text, { sidecar, limit = 5, exclude }) {
  return describe(board, searchItems(board, text, { sidecar, exclude, limit }));
}

/**
 * The nearest open items to a text, for advice when an item is filed; it reads the sidecar as it is unless it is missing or
 * well behind the board, so filing stays fast, and it throws on a broken index for the caller to ignore.
 * Why rank, not a score threshold: duplicates score from 0.17 to 1.0, inside the noise of unrelated items [C7].
 *
 * @param {object} board - An open board.
 * @param {string} text - The new item's title, criterion and brief.
 * @param {{ sidecar: string, limit?: number, exclude?: number[] }} options
 * @returns {{ id: number, score: number, state: string, title: string }[]}
 */
export function nearestOpenItems(board, text, { sidecar, limit = 3, exclude = [] }) {
  const stored = readSearchIndex(sidecar);
  const total = board.db.prepare('SELECT COUNT(*) AS n FROM item').get().n;
  const index = stored && total - stored.ids.length <= STALE_ITEMS ? stored : buildSearchIndex(board, { sidecar });
  const open = new Set(board.db.prepare(`SELECT item_id AS id FROM item WHERE item_status NOT IN (${CLOSED.map(() => '?').join(',')})`).all(...CLOSED).map(row => row.id));
  const skip = new Set(exclude);
  const hits = rank(index, text, { limit: Infinity, exclude });
  // Items filed since the sidecar was built are scored here against its vocabulary, so a duplicate of last minute's item is still found.
  const newest = index.ids.reduce((most, id) => Math.max(most, id), 0);
  const query = vectorize(tokens(text), index.idf);
  for (const row of board.db.prepare('SELECT item_id AS id, item_title AS title, item_criterion AS criterion, item_brief AS brief FROM item WHERE item_id > ?').all(newest)) {
    if (skip.has(row.id)) continue;
    const vector = vectorize(tokens(itemText(row)), index.idf);
    let score = 0;
    for (const [term, weight] of query) score += weight * (vector.get(term) ?? 0);
    if (score > 0) hits.push({ id: row.id, score });
  }
  hits.sort((a, b) => b.score - a.score || a.id - b.id);
  return describe(board, hits.filter(hit => open.has(hit.id)).slice(0, limit));
}
