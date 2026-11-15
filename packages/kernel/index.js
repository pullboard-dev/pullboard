/** Pure discovery, parsing, refusal and registry obligations shared by every cell [C7]. */
export * from './src/logic/discovery.js';
export * from './src/logic/lex.js';
export * from './src/logic/words.js';
export { Refused, repoPath } from './light.js';
export * from './src/logic/registry.js';
export { PIPELINE_CAUSES, pipelineCause, pipelineCauseType } from './src/logic/cause.js';
export { decodedProofEvent, proofEventDetail } from './src/logic/detail.js';

export { auditAdapterEnvironment } from './src/logic/audit.js';
export { createRelayAdapter, createFakeRelayAdapter } from './src/logic/adapter.js';
export { parseProcessCensus } from './src/logic/census.js';
export { machineHome } from './light.js';
export { engineBindings } from './src/logic/engine-declarations.js';
export { RUNNER_PRELOAD_ENV, declareKnownNodeOption, declareNodeOptionProofs, foreignNodeOptions } from './src/logic/node/options.js';
export { seal, unseal, generateBoardKey, encodeBoardKey, decodeBoardKey } from './src/logic/seal.js';
export { MAIN_FAILURE_SIGNATURE_VERSION, normalizedFailureDiagnostics, tapFailureDiagnostics, caseSignatures, FAILURE_DIAGNOSTICS_SOURCE } from './src/logic/failure/diagnostics.js';
