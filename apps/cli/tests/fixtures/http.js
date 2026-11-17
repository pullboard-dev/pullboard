/** The fresh-connection fixture request lives beside the sync package's tests, so package tests use it without importing the CLI; this file is the CLI kit's one door to it [C7]. */
import {
  causeChain as syncCauseChain,
  fetchFresh as syncFetchFresh,
} from '../../../../packages/sync/tests/fixtures/http.js';

/**
 * Send one request to a live fixture server on a connection of its own (see the sync package's fixture).
 *
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function fetchFresh(url, init) {
  return syncFetchFresh(url, init);
}

/**
 * Describe an error and every cause beneath it (see the sync package's fixture).
 *
 * @param {unknown} error
 * @returns {string}
 */
export function causeChain(error) {
  return syncCauseChain(error);
}
