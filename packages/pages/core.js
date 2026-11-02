/** Browser-safe Pages protocols and sealed values; the full entry retains I/O [C7]. */
export { CURRENT_SNAPSHOT_BYTES, currentSnapshotPresentation, encodePagedSnapshot, openPagedSnapshot } from './src/core/relay-page-layout.js';
export { legacyPageRoute, relayStorage, relayStorageLine } from './src/core/relay-page-support.js';
export { PAGE_BYTES, PAGE_CIPHER_BYTES, PAGE_FANOUT, pageDigest, pageReference, readSealedBytes, readSealedDescriptor, readSealedValue, sealedPageFingerprint, writeSealedDescriptor, writeSealedValue } from './src/core/sealed-pages.js';
export { presentationShout } from './src/core/relay-presentation.js';
