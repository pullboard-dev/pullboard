/** Feature discovery and historical constants, without lifecycle declarations [C7,V4]. */
import { fileURLToPath } from 'node:url';
import {
  engineNumber,
  nextEngineNumber,
  readEngineLeaves,
} from './numbers.js';

export const AUTO_ESCALATE_ENGINE = engineNumber('AUTO_ESCALATE_ENGINE');
export const ROW_DRAFT_ENGINE = engineNumber('ROW_DRAFT_ENGINE');
export const STRONG_REJECTION_NOTICE_ENGINE = engineNumber('STRONG_REJECTION_NOTICE_ENGINE');
export const SUBMITTED_CONFLICT_ENGINE = engineNumber('SUBMITTED_CONFLICT_ENGINE');
export const WITHDRAW_MILESTONE_ENGINE = engineNumber('WITHDRAW_MILESTONE_ENGINE');

/**
 * Find every feature engine: each packages/state/src/logic/engines/*-engine.js leaf declares exactly one `export const NAME_ENGINE = n;` line.
 * A feature that raises the engine adds its own new file and no line of any shared one, so two items adding
 * different engines never conflict [C7,V4]. An unlanded leaf says `= unassignedEngine();` and reads as one above
 * the landed engines until the landing merge gives it its number (#1101). The value is read as text because
 * machine.js needs it synchronously.
 *
 * @param {URL} directory the folder holding the *-engine.js leaves
 * @returns {Record<string, number>} engine number by file name, in name order
 */
export function discoverEngines(directory = new URL('../../logic/engines/', import.meta.url)) {
  const leaves = readEngineLeaves(fileURLToPath(directory));
  const unlanded = nextEngineNumber(leaves);
  const entries = leaves.map((leaf) => [leaf.file.slice(0, -'-engine.js'.length), leaf.number ?? unlanded]);
  return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export const REOPEN_FIRST_REFUSAL_ENGINE = engineNumber('REOPEN_FIRST_REFUSAL_ENGINE');
export const QUOTED_LANDING_FAILURE_ENGINE = engineNumber('QUOTED_LANDING_FAILURE_ENGINE');

/** Every feature engine by name, discovered from the *-engine.js files in the state cell's engines folder. */
export const ENGINE_REGISTRY = discoverEngines();

/** The highest engine number any feature declares. */
export const ENGINE_VERSION = Math.max(...Object.values(ENGINE_REGISTRY));

/**
 * The engine whose relay moves carry seat provenance and verifier standing (#579). It is its own
 * constant because engine slots are allotted per item: whoever lands second renumbers this line.
 */
export { VERIFIER_STANDING_ENGINE } from '../../logic/move/constants.js';

/** The engine at which reject, reopen and person facts may carry cause keys [D1,H16]. */
export { CAUSE_ENGINE } from '../../logic/move/constants.js';

/** First released engine binding the checked composition, review trunk and paths [E8,H16]. */
export { VERDICT_REVIEW_ENGINE } from '../../logic/move/constants.js';

export const MILESTONE_RANK_ENGINE = engineNumber('MILESTONE_RANK_ENGINE');

