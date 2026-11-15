/** Pure tokenising and TF-IDF scoring for similar-item search, ported from the 1 Nov similar-item research [C7]. */

/** Words too common on the board to tell items apart. */
const STOP = new Set(('a an the and or of to in on for with by from at as is are was were be been it its this that these those not no but if then than so such '
  + 'can will should must may after before into onto per each every any all one two when which who whom what where how also only own same via over under '
  + 'about up out off use used using uses new item items').split(' '));

/**
 * Strip one common English suffix.
 * Why: "refuses", "refused" and "refusing" should meet on one term without a stemming library.
 *
 * @param {string} word
 * @returns {string}
 */
export function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Split text into search terms: camelCase, paths and ids break apart; stopwords and one- or two-digit numbers drop.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokens(text) {
  const raw = String(text ?? '').replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  const out = [];
  for (const word of raw) {
    if (STOP.has(word) || word.length < 2 || /^\d{1,2}$/u.test(word)) continue;
    out.push(stem(word));
  }
  return out;
}

/**
 * The text one item contributes to the index: its title, criterion and brief.
 *
 * @param {{ title?: string, criterion?: string, brief?: string }} item
 * @returns {string}
 */
export function itemText(item) {
  return [item.title, item.criterion, item.brief].filter(Boolean).join('\n');
}

/**
 * A unit-length TF-IDF vector for one token list, with sublinear term frequency; unknown terms drop.
 *
 * @param {string[]} terms
 * @param {Map<string, number>} idf
 * @returns {Map<string, number>}
 */
export function vectorize(terms, idf) {
  const tf = new Map();
  for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
  const vector = new Map();
  let norm = 0;
  for (const [term, count] of tf) {
    const weight = idf.get(term);
    if (weight === undefined) continue;
    const value = (1 + Math.log(count)) * weight;
    vector.set(term, value);
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [term, value] of vector) vector.set(term, value / norm);
  return vector;
}

/**
 * Build an index over documents, each an id and its text.
 *
 * @param {{ id: number, text: string }[]} docs
 * @returns {{ ids: number[], idf: Map<string, number>, vectors: Map<string, number>[] }}
 */
export function buildIndex(docs) {
  const lists = docs.map(doc => tokens(doc.text));
  const df = new Map();
  for (const list of lists) for (const term of new Set(list)) df.set(term, (df.get(term) ?? 0) + 1);
  const idf = new Map();
  for (const [term, count] of df) idf.set(term, Math.log(1 + docs.length / count));
  return { ids: docs.map(doc => doc.id), idf, vectors: lists.map(list => vectorize(list, idf)) };
}

/**
 * Rank indexed items by cosine similarity to a query text, best first; ties order by id, and zero scores drop.
 *
 * @param {{ ids: number[], idf: Map<string, number>, vectors: Map<string, number>[] }} index
 * @param {string} text
 * @param {{ limit?: number, exclude?: number[] }} [options]
 * @returns {{ id: number, score: number }[]}
 */
export function rank(index, text, { limit = 3, exclude = [] } = {}) {
  const query = vectorize(tokens(text), index.idf);
  const skip = new Set(exclude);
  const hits = [];
  index.vectors.forEach((vector, at) => {
    if (skip.has(index.ids[at])) return;
    let score = 0;
    for (const [term, weight] of query) score += weight * (vector.get(term) ?? 0);
    if (score > 0) hits.push({ id: index.ids[at], score });
  });
  hits.sort((a, b) => b.score - a.score || a.id - b.id);
  return hits.slice(0, limit);
}

/**
 * The index as plain JSON data, for the sidecar file.
 *
 * @param {{ ids: number[], idf: Map<string, number>, vectors: Map<string, number>[] }} index
 * @returns {{ ids: number[], idf: [string, number][], vectors: [string, number][][] }}
 */
export function indexToJson(index) {
  return { ids: index.ids, idf: [...index.idf], vectors: index.vectors.map(vector => [...vector]) };
}

/**
 * Read an index back from its sidecar JSON data.
 *
 * @param {{ ids: number[], idf: [string, number][], vectors: [string, number][][] }} data
 * @returns {{ ids: number[], idf: Map<string, number>, vectors: Map<string, number>[] }}
 */
export function indexFromJson(data) {
  return { ids: data.ids, idf: new Map(data.idf), vectors: data.vectors.map(rows => new Map(rows)) };
}
