/** The app door to the board package's fixture board: one declared apps/lib to board edge serves every app test [C7]. */
import { fixtureBoard as packageFixtureBoard } from '../../../../packages/board/tests/fixtures/board.js';
export { fixtureOpenBoard, openKitBoard, openFixtureComposition, withFixtureBoard } from '../../../../packages/board/tests/fixtures/board.js';

/** Open an in-memory (or named file) production board through the board package's fixture. */
export function fixtureBoard(t, options) {
  return packageFixtureBoard(t, options);
}
