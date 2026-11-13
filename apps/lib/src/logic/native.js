/** The board composition root moved to packages/board; this path re-exports the same functions through the lib's light door, which binds the runner and the view [C7]. */
export { board, closeBoard, nativeBoardPorts, openBoard, openBoardForRead, draftSpecRow, decideSpecRevisions, recordRowVerification } from '../../light.js';
export { advanceItemSource, proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun, flakeLedger, recordFlakeObservation, flakeQuarantines, gateRuns, recordGateRun } from '../../light.js';
export { personProposals, personSigning, proposePersonMove, setPersonSigning, recordPublishFinding, landingWaivers, landingWaiverFor, waivedLandingProof, recordTrainLanding } from '../../light.js';
