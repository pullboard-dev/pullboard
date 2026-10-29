/** Rigor drafts, counters, notices, quality and proof behind one front door [C7,CD60,CD64]. */
export { planAutomaticRigorApply } from './src/shell/rigor-auto-apply.js';
export { deriveRigorCause, recordAutomaticRigorDrafts } from './src/shell/rigor-auto.js';
export { conflictReport, conflictLines, splitProposal, splitAlreadyProposed, conflictNoteFiles } from './src/shell/rigor-conflicts.js';
export { rigorCounterKeys, rigorCounterChange, advanceRigorCounter, rigorCounterEligible, rigorCounterResult, sortRigorCounters } from './src/core/rigor-counter-state.js';
export { RIGOR_TAIL_LIMIT, RIGOR_COLD_NOTICE, appendRigorCounter, ensureRigorCounters, resumeRigorCounters } from './src/shell/rigor-counters.js';
export { rigorDraft, rigorDraftCommand } from './src/shell/rigor-draft.js';
export { rigorTriggerCauses, newRigorNotices, rigorDraftNeeds, undraftedRigor, rigorNoticeText } from './src/core/rigor-notices.js';
export { unproven, prepareCauseProof, runCheckAt, proveCauseCheck } from './src/shell/rigor-proof.js';
export { qualitySource, qualityRows, qualityCommand, rigorQualityCommand, draftQualityRows } from './src/shell/rigor-quality-draft.js';
export { LINE_CAP, GROWTH_BUDGET, QUALITY_RULES, changeRange, parseDiff, nodeTests, qualityBreaches, breachLine } from './src/shell/rigor-quality.js';
export { draftConflictSplits } from './src/shell/rigor-splits.js';
