/** Browser-safe kernel pieces: refusal identity, source lexing, the relay request adapter, the device-sealed format and the proof event detail, with no node: built-in [C7,D3]. */
export { lex, lineAt } from './src/logic/lex.js';
export { seal, unseal, generateBoardKey, encodeBoardKey, decodeBoardKey } from './src/logic/seal.js';
export { proofEventDetail } from './src/logic/detail.js';
export { Refused } from './src/logic/refused.js';
export { createRelayAdapter, createFakeRelayAdapter } from './src/logic/adapter.js';

/** The name of the committed coordinator settings file: the one home of this literal, so light doors ask here instead of repeating it; it lives in this door so a command loads one module less [CD2,C7]. */
export const CONFIG_FILE = 'pullboard.json';

/** Whether a path or tree entry name is the coordinator settings file. */
export function isConfigFile(name) { return name === CONFIG_FILE; }
