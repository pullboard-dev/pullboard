/** Browser-safe kernel pieces: refusal identity, source lexing, the relay request adapter, the device-sealed format and the proof event detail, with no node: built-in [C7,D3]. */
export { lex, lineAt } from './src/logic/lex.js';
export { seal, unseal, generateBoardKey, encodeBoardKey, decodeBoardKey } from './src/logic/seal.js';
export { proofEventDetail } from './src/logic/detail.js';
export { Refused } from './src/logic/refused.js';
export { createRelayAdapter, createFakeRelayAdapter } from './src/logic/adapter.js';
