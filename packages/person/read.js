/**
 * Person read door: the passkey proof reads spec approval projections through the spec light door.
 * Not light.js, which browser graphs load (keys/src/logic/device.js reads it): proof.js imports node:util and the spec light door [C7].
 */
export {
  signedRowDecisionsMatch,
  verifiedPasskeyRowDecision,
} from './src/io/proof.js';
