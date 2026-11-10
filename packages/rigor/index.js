/** Rigor drafts, counters, notices, quality and proof behind one front door [C7,CD60,CD64]. */
export { coordinatorInstructionKinds, coordinatorInstructionReport } from './src/logic/instructions.js';
export { planAutomaticRigorApply } from './src/io/auto/apply.js';
export { deriveRigorCause, recordAutomaticRigorDrafts } from './src/io/auto.js';
export { conflictReport, conflictLines, splitProposal, splitAlreadyProposed, conflictNoteFiles } from './src/io/conflicts.js';
export { rigorCounterKeys, rigorCounterChange, advanceRigorCounter, rigorCounterEligible, rigorCounterResult, sortRigorCounters } from './src/logic/counter.js';
export { RIGOR_TAIL_LIMIT, RIGOR_COLD_NOTICE, appendRigorCounter, ensureRigorCounters, resumeRigorCounters } from './src/io/counters.js';
export { rigorDraft, rigorDraftCommand } from './src/io/draft.js';
export { rigorTriggerCauses, newRigorNotices, rigorDraftNeeds, undraftedRigor, rigorNoticeText } from './src/logic/notices.js';
export { unproven, prepareCauseProof, runCheckAt, proveCauseCheck } from './src/io/proof.js';
export { qualitySource, qualityRows, qualityCommand, rigorQualityCommand, draftQualityRows } from './src/io/quality/draft.js';
export { LINE_CAP, GROWTH_BUDGET, QUALITY_RULES, changeRange, parseDiff, nodeTests, qualityBreaches, breachLine } from './src/io/quality.js';
export { draftConflictSplits } from './src/io/splits.js';
