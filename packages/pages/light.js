/** Browser-safe Pages protocols and sealed values; the full entry retains I/O [C7]. */
export { CURRENT_SNAPSHOT_BYTES, currentSnapshotPresentation, encodePagedSnapshot, openPagedSnapshot } from './src/logic/relay/layout.js';
export { legacyPageRoute, relayStorage, relayStorageLine } from './src/logic/relay/storage.js';
export { PAGE_BYTES, PAGE_CIPHER_BYTES, PAGE_FANOUT, pageDigest, pageReference, readSealedBytes, readSealedDescriptor, readSealedValue, sealedPageFingerprint, writeSealedDescriptor, writeSealedValue } from './src/logic/sealed.js';
export { presentationShout } from './src/logic/relay/presentation.js';
