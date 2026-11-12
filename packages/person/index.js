/** Pairing, signed person actions and presentation behind one front door [C7]. */
export { createPairingCode, parsePairingCode, sealPairingBundle, openPairingBundle } from './src/io/pairing.js';
export { rememberAttested, attestedAuthority } from './src/logic/attested.js';
export { executingBarEffect, confirmBarEffect, personBarMode } from './src/io/bar.js';
export { awaitPersonConfirmation } from './src/io/confirmation.js';
export { presenceAttestation, presenceSigned, validPresence } from './src/io/presence.js';
export { signedRowDecisionsMatch, verifiedPasskeyRowDecision } from './src/io/proof.js';
export { pinRelayAuthority, attestBeforeCommand, requireSignedPerson, refuseUnsignedMove, signsPersonMoves, personMovesSigned, signingSetting, refuseNamedSigners, requireShownRows } from './src/io/signing/cli.js';
export { personSigningPresentation } from './src/logic/signing/presentation.js';
export { localAuthority, pinAuthority, attestAuthority, authorityAttested, authorityNeeded, offPending, personSigning, stampSigningFormat, setPersonSigning, personProposals, proposePersonMove, requestPresence, passkeyConfirmed, signedRefusal, signedMoveProblem, guardRestore, exportedMeta } from './src/io/signing.js';
export { remoteShell, personCommand, requirePersonChannel, requireRelayOnChannel, personShout, agentSessionDigest } from './src/io/main.js';
export { PAIR_PACKAGE_BYTES } from './src/io/pairing/limit.js';
export { requestIntentDigest } from './src/io/digest.js';
export * from './light.js';
export { realRelayAdapter, createFakeRelayAdapter, withRelayAdapter, relayFetch } from './src/io/adapter.js';
