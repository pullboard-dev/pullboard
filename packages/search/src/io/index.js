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

/**
 * The best matches for a text with each item's state and title, for a person to read.
 *
 * @param {object} board - An open board.
 * @param {string} text
 * @param {{ sidecar: string, limit?: number, exclude?: number[], open?: boolean }} options - `open` keeps only items still to be done.
 * @returns {{ id: number, score: number, state: string, title: string }[]}
 */
export function searchItemRows(board, text, { sidecar, limit = 5, exclude, open = false }) {
  const byId = new Map(listItems(board, { all: true }).map(item => [item.item_id, item]));
  const closed = new Set(['verified', 'withdrawn']);
  const hits = searchItems(board, text, { sidecar, exclude, limit: open ? Infinity : limit });
  return hits
    .map(hit => ({ id: hit.id, score: hit.score, state: byId.get(hit.id)?.item_status ?? 'unknown', title: byId.get(hit.id)?.item_title ?? '' }))
    .filter(row => !open || !closed.has(row.state))
    .slice(0, limit);
}
