/** Pairing, signed person actions and presentation behind one front door [C7]. */
export { createPairingCode, parsePairingCode, sealPairingBundle, openPairingBundle } from './src/shell/pairing.js';
export { rememberAttested, attestedAuthority } from './src/core/person-attested.js';
export { executingBarEffect, confirmBarEffect, personBarMode } from './src/shell/person-bar-cli.js';
export { awaitPersonConfirmation } from './src/shell/person-confirmation.js';
export { presenceAttestation, presenceSigned, validPresence } from './src/shell/person-presence.js';
export { signedRowDecisionsMatch, verifiedPasskeyRowDecision } from './src/shell/person-row-proof.js';
export { pinRelayAuthority, attestBeforeCommand, requireSignedPerson, refuseUnsignedMove, signsPersonMoves, personMovesSigned, signingSetting, refuseNamedSigners, requireShownRows } from './src/shell/person-signing-cli.js';
export { personSigningPresentation } from './src/core/person-signing-presentation.js';
export { localAuthority, pinAuthority, attestAuthority, authorityAttested, authorityNeeded, offPending, personSigning, stampSigningFormat, setPersonSigning, personProposals, proposePersonMove, requestPresence, passkeyConfirmed, signedRefusal, signedMoveProblem, guardRestore, exportedMeta } from './src/shell/person-signing.js';
export { remoteShell, personCommand, requirePersonChannel, requireRelayOnChannel, personShout, agentSessionDigest } from './src/shell/person.js';
export { PAIR_PACKAGE_BYTES } from './src/shell/person-pairing-limit.js';
export { requestIntentDigest } from './src/shell/person-request-digest.js';
export * from './core.js';
