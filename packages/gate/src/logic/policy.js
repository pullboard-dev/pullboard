/** Pure runner registration, source identity and transport-loss types shared by admission [C7,Q1]. */
export { runnerSource } from './runner-source.js';
export { RunnerDropped } from './runner-source.js';

/** Preserve the canonical pure registration validator without loading the full runner. */
export { validateRunner } from '../../../config/index.js';
