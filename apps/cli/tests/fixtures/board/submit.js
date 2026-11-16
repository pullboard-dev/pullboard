/** Board-state fixtures supply the receipt required by modern submits; their home is the store package's tests [C7,V4]. */
export {
  staleVerdictCheckFixture,
  submitFixture,
  repositoryBoardFile,
  policyRepository,
  temporaryRepository,
} from '../../../../../packages/store/tests/fixtures/submit.js';
/** The store cell's fixture opens its boards through this app door, which reaches the board package's fixture through the lib door. */
export { openKitBoard } from '../../../../lib/tests/fixtures/board.js';
