/** Compose standalone view projection with the native board opener; borrowed connections keep their owner [N26,A5]. */
import { projectState as projectProvidedState } from '../../../view/index.js';
import { nativeBoardOpeners } from './context.js';
import * as nativeBoard from '../../../lib/index.js';

/** Supply the same canonical native board services used by actual CLI view composition. */
export function projectState(root, options = {}) {
  return projectProvidedState(root, { ...options, boardOpeners: nativeBoardOpeners({ nativeBoard }) });
}
