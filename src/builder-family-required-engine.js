import { unassignedEngine } from './engine-next.js';
/** Required-family boards refuse undeclared builders before claiming or recording a submission [C7,#3078]. */
export const BUILDER_FAMILY_REQUIRED_ENGINE = unassignedEngine();
