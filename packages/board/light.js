/** The board's light door: the open path, the view binding and the proof-runner binding, without the barrel's composition [C7]. */
export { bindBoardView } from './src/io/providers.js';
export { nativeBoardPorts, openBoard, openBoardForRead } from './src/io/open.js';
export { bindProofRunner } from '../verify/index.js';
