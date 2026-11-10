/**
 * The receipt cell's front door: pure judgement of collected gate results, the verdict step, and keyed reuse [C7].
 *
 * The collected-results shape `judge` takes (the drive cell builds to this): an object with one entry per section in
 * SECTIONS (static, criterion, proof, cells, comparison), each `{ outcome: 'pass' | 'fail' | 'skip' | 'infra',
 * code?: string }`. A missing or invalid section judges as infra. The verdict is red if any section failed, else
 * infra if any was lost, else green. A receipt for reuse is `{ candidate, base, verdict }` with tree ids.
 */
export { SECTIONS, OUTCOMES, judge, verdictStep, settle } from './src/logic/judge.js';
export { receiptKey, reusable, receiptByKey } from './src/logic/reuse.js';
export { mainRedKey, mainReceiptByKey, mainRedStatus, classifyMainRed, comparisonStatus, MAIN_TEST_JOB, mainTestJobId } from './src/logic/main/red.js';
export { resultStatement, runnerKeyId, checkSignedResult } from './src/logic/signed.js';
