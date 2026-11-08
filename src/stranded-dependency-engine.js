/** A dependency with measured idle work returns at its configured interval, without reclaiming live jobs [C7,B4]. */
import { unassignedEngine } from './engine-next.js';
export const STRANDED_DEPENDENCY_ENGINE = unassignedEngine();
