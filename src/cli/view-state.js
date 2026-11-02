/** Compose standalone view projection with the native board opener; borrowed connections keep their owner [N26,A5]. */
import { projectState as projectProvidedState } from '../serve.js';
import { nativeBoardOpeners } from '../cli-context.js';
import * as nativeBoard from '../native-board.js';

/** Supply the same canonical native board services used by actual CLI view composition. */
export function projectState(root, options = {}) {
  return projectProvidedState(root, { ...options, boardOpeners: nativeBoardOpeners({ nativeBoard }) });
}
