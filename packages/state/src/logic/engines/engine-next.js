/** The engine number an unlanded leaf reads as on its branch: one above the highest landed engine (#1101). */
import { fileURLToPath } from 'node:url';
import {
  nextEngineNumber,
  readEngineLeaves,
} from '../../io/engine/numbers.js';

/**
 * One above the highest landed engine among this directory's leaves; the landing merge writes the real number.
 *
 * @returns {number}
 */
export function unassignedEngine() {
  return nextEngineNumber(readEngineLeaves(fileURLToPath(new URL('./', import.meta.url))));
}
