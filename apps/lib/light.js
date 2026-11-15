/** @pullboard-module-loads apps/view/index.js */
/** The native board alone, without the library barrel's workers (gate, landing, handoff) [C7]. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bindProofRunner } from '../../packages/board/index.js';
import { bindBoardView } from '../../packages/board/index.js';
import { nativeBoardPorts } from '../../packages/board/index.js';
import { openBoard } from '../../packages/board/index.js';
import { openBoardForRead } from '../../packages/board/index.js';

// The board composition root lives in packages/board; this app binds the two things only an app may name [C7].
// Rule-proof coverage compares committed runner bytes with this installed file; verify never imports the runner's cell.
bindProofRunner(fileURLToPath(new URL('../cli/src/io/run/tests.js', import.meta.url)));
const requireModule = createRequire(import.meta.url);
// The view app loads at the first projection call, never at open: next and other board moves never pay for its modules.
bindBoardView(() => requireModule('../view/index.js'));

/** What the CLI process opens boards with; the barrel's other exports load only where a worker needs them. */
export const nativeBoard = Object.freeze({ openBoard, openBoardForRead, nativeBoardPorts });
export { board, closeBoard, nativeBoardPorts, openBoard, openBoardForRead, draftSpecRow, decideSpecRevisions, recordRowVerification } from '../../packages/board/index.js';
export { advanceItemSource, proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun, flakeLedger, recordFlakeObservation, flakeQuarantines, gateRuns, recordGateRun } from '../../packages/board/index.js';
export { personProposals, personSigning, proposePersonMove, setPersonSigning, recordPublishFinding, landingWaivers, landingWaiverFor, waivedLandingProof, recordTrainLanding } from '../../packages/board/index.js';
