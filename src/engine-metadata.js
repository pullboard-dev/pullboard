/** Feature discovery and historical constants, without lifecycle declarations [C7,V4]. */
import { fileURLToPath } from 'node:url';
import {
  nextEngineNumber,
  readEngineLeaves,
} from './engine-numbers.js';

export { AUTO_ESCALATE_ENGINE } from './auto-escalate-engine.js';
export { ROW_DRAFT_ENGINE } from './row-draft-engine.js';
export { ROUTE_CALIBRATION_ENGINE } from './route-calibration-engine.js';
export { STRONG_REJECTION_NOTICE_ENGINE } from './strong-rejection-notice-engine.js';
export { SUBMITTED_CONFLICT_ENGINE } from './submitted-conflict-engine.js';
export { WITHDRAW_MILESTONE_ENGINE } from './withdraw-milestone-engine.js';

/**
 * Find every feature engine: each src/*-engine.js leaf declares exactly one `export const NAME_ENGINE = n;` line.
 * A feature that raises the engine adds its own new file and no line of any shared one, so two items adding
 * different engines never conflict [C7,V4]. An unlanded leaf says `= unassignedEngine();` and reads as one above
 * the landed engines until the landing merge gives it its number (#1101). The value is read as text because
 * machine.js needs it synchronously.
 *
 * @param {URL} directory the folder holding the *-engine.js leaves
 * @returns {Record<string, number>} engine number by file name, in name order
 */
export function discoverEngines(directory = new URL('./', import.meta.url)) {
  const leaves = readEngineLeaves(fileURLToPath(directory));
  const unlanded = nextEngineNumber(leaves);
  return Object.fromEntries(leaves.map((leaf) => [leaf.file.slice(0, -'-engine.js'.length), leaf.number ?? unlanded]));
}

export { REOPEN_FIRST_REFUSAL_ENGINE } from './reopen-first-refusal-engine.js';
export { QUOTED_LANDING_FAILURE_ENGINE } from './quoted-landing-failure-engine.js';

/** Every feature engine by name, discovered from the *-engine.js files beside this one. */
export const ENGINE_REGISTRY = discoverEngines();

/** The highest engine number any feature declares. */
export const ENGINE_VERSION = Math.max(...Object.values(ENGINE_REGISTRY));

/**
 * The engine whose relay moves carry seat provenance and verifier standing (#579). It is its own
 * constant because engine slots are allotted per item: whoever lands second renumbers this line.
 */
export const VERIFIER_STANDING_ENGINE = 48;

/** The engine at which reject, reopen and person facts may carry cause keys [D1,H16]. */
export const CAUSE_ENGINE = 30;

/** First released engine binding the checked composition, review trunk and paths [E8,H16]. */
export const VERDICT_REVIEW_ENGINE = 33;

export { MILESTONE_RANK_ENGINE } from './milestone-rank-engine.js';

