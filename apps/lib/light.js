/** The native board alone, without the library barrel's workers (gate, landing, handoff) [C7]. */
import { nativeBoardPorts } from './src/logic/native.js';
import { openBoard } from './src/logic/native.js';
import { openBoardForRead } from './src/logic/native.js';

/** What the CLI process opens boards with; the barrel's other exports load only where a worker needs them. */
export const nativeBoard = Object.freeze({ openBoard, openBoardForRead, nativeBoardPorts });
