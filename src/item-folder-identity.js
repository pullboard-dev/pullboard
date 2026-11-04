/** Preserve this module's public names from the leaf module, not the apps/cli front door, so packages that import it never load the whole CLI and cycle back into the move registry [C7]. */
export { claimedItemRoot, itemFolderIdentity, itemFolderPath, seatAt, seatRoot, writeItemMarker } from '../apps/cli/src/shell/item-folder-identity.js';
