/** Browser-safe kernel pieces: the device-sealed format and the proof event detail, with no node: built-in [C7,D3]. */
export { seal, unseal, generateBoardKey, encodeBoardKey, decodeBoardKey } from './src/core/seal.js';
export { proofEventDetail } from './src/core/event-detail.js';
