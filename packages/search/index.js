/** Similar-item search: a TF-IDF index over item title, criterion and brief, rebuilt from the board [C7]. */
export { SEARCH_SIDECAR_VERSION, boardDocuments, buildSearchIndex, readSearchIndex, searchIndex, searchItems } from './src/io/index.js';
export { stem, tokens, itemText, vectorize, buildIndex, rank, indexToJson, indexFromJson } from './src/logic/tfidf.js';
