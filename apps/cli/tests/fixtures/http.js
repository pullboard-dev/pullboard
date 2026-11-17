/** The fresh-connection fixture request now lives beside the sync package's tests, so package tests can use it without importing the CLI [C7]. */
export {
  fetchFresh,
  causeChain,
} from '../../../../packages/sync/tests/fixtures/http.js';
