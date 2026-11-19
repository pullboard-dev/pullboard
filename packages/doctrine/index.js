/** Standard doctrine, rulings and doctrine checks behind one front door [C7,CD60,CD64]. */
export * from './light.js';
export * from './src/io/checks.js';
export * from './src/io/rulings.js';
export * from './src/io/main.js';
export * from './src/io/fast.js';
export * from './src/io/history.js';
export * from './src/io/main-criterion-facts.js';
export * from './src/io/bundle/import.js';
export { encodeBundle } from './src/logic/bundle/encode.js';
export { signBundle, verifyBundle } from './src/io/bundle/verify.js';
export { signWaiver, waiverPermits } from './src/io/bundle/waiver.js';

/** The standard decision line module loads at the call, so status and next never load it; an app passes this function on as a port [C7,#2007]. */
export function loadStandardDecision() {
  return import('./src/logic/standard-decision.js');
}
