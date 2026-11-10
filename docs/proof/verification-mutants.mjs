/**
 * The proof audit of the verification rows, V1 to V9 (item #48) and V16 (item #51): for each row,
 * one or more changes to the code that break the row's rule, and the tagged test that must go red under
 * each. The harness works on a temporary copy, never a real checkout.
 *
 * Three V16 rows (submit or the gate trusting a stamp) are retired: submit no longer reads the gate stamp
 * at all, so no one-line change to submit can make it trust one. The tests that judged them stay.
 *
 * Run it from the repo root: node docs/proof/verification-mutants.mjs
 */
import { audit } from './harness.mjs';

const VERIFY_AT_COMMIT = ['apps/cli/journeys/spec/e2e.test.js', 'verify runs at the submitted commit, against the criterion frozen at claim'];
const CLEAN_TREE = ['apps/cli/journeys/gate/slot.test.js', 'submit needs a clean tree, nothing untracked, and the gate green at HEAD'];
const VERDICT_RULES = ['apps/cli/journeys/resume/board.test.js', 'ACCEPT needs CRITERION_MET'];
const BOARD_CRITERION = ['packages/store/src/io/board/verify.js', '        criterionUnchanged: (found) =>\n          digest === found.item_frozen_digest', '        criterionUnchanged: (found) =>\n          true || digest === found.item_frozen_digest'];
const CLI_CRITERION = 'if (digest !== item.item_frozen_digest) throw new Refused(\'CRITERIA_CHANGED\'';
const CLI_CRITERION_OFF = 'if (false) throw new Refused(\'CRITERIA_CHANGED\'';
const RED_GATE = ['apps/cli/src/io/commands/submit.js', 'if (redCriterion || !gate.isGreen && !waived && !proofMatched) {', 'if (false) {'];
const VERDICT_INSERT = '.run(item.item_id, agentId, decision, reason, note.trim(), item.item_commit,';
const MOVED = 'if (headCommit(root) !== commit || !isClean(root)) {';
const MOVED_TREE = ['apps/cli/journeys/gate/main.test.js', 'submit refuses a tree its gate left changed'];

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['V1', 'the builder may verify its own work', [['packages/store/src/io/board.js', 'notBuilder: (found) => itemAuthorProblem(board, found, agentId, { reviewPatchAuthors, committedItemAuthors, twoTierReviews, strictReviewProblem }),', 'notBuilder: () => null,']], ['apps/cli/journeys/resume/board.test.js', 'the builder never verifies its own work'], 'red'],
  ['V2', 'every claim refreezes the criterion', [['packages/store/src/io/board/claim.js', '        if (found.item_frozen_digest !== null && !adopts && !refreshes) return null;\n', '']], ['apps/cli/journeys/resume/board.test.js', 'the first claim freezes the criterion'], 'red'],
  ['V2', 'the freeze leaves out the title', [['packages/spec/src/io/main.js', 'JSON.stringify({ title: item.item_title, criterion:', 'JSON.stringify({ criterion:']], ['apps/cli/journeys/spec/main.test.js', 'the frozen criterion covers title'], 'red'],
  ['V2', 'the freeze leaves out the cited row text', [['packages/spec/src/io/main.js', 'return { id, text: row.text, gate: row.gate };', 'return { id, gate: row.gate };']], ['apps/cli/journeys/spec/main.test.js', 'the frozen criterion covers title'], 'red'],
  ['V3', 'the board takes a verdict against a moved criterion', [BOARD_CRITERION], ['apps/cli/journeys/resume/board.test.js', 'a verdict against a moved criterion is refused'], 'red'],
  ['V3', 'the CLI and the board both take a moved criterion', [BOARD_CRITERION, ['apps/cli/src/io/commands/verify.js', CLI_CRITERION, CLI_CRITERION_OFF], ['apps/cli/src/io/commands/verify.js', CLI_CRITERION, CLI_CRITERION_OFF]], VERIFY_AT_COMMIT, 'red'],
  ['V3', "the CLI's own check alone is removed; the board still refuses with the same code", [['apps/cli/src/io/commands/verify.js', CLI_CRITERION, CLI_CRITERION_OFF], ['apps/cli/src/io/commands/verify.js', CLI_CRITERION, CLI_CRITERION_OFF]], VERIFY_AT_COMMIT, 'green'],
  ['V4', 'submit takes a dirty tree', [['apps/cli/src/io/commands/submit.js', "if (!isClean(root)) throw new Refused('DIRTY'", "if (false) throw new Refused('DIRTY'"]], CLEAN_TREE, 'red'],
  ['V4', 'submit takes untracked files', [['apps/cli/src/io/commands/submit.js', "if (stray.length) throw new Refused('UNTRACKED'", "if (false) throw new Refused('UNTRACKED'"]], CLEAN_TREE, 'red'],
  ['V4', 'submit takes a red gate', [RED_GATE], ['apps/cli/journeys/spec/e2e.test.js', 'a red gate refuses submit'], 'red'],
  ['V5', 'an accept needs no proof note', [['packages/store/src/io/board/verify.js', '        proofNoted: () =>\n          suppliedNote', '        proofNoted: () =>\n          true || suppliedNote']], VERDICT_RULES, 'red'],
  ['V5', 'an accept may give another reason', [['packages/store/src/io/board/verify.js', 'reasonIsMet: () => (reason && reason !== ACCEPT_REASON ?', 'reasonIsMet: () => (false ?']], VERDICT_RULES, 'red'],
  ['V5', 'a reject needs no reason code', [['packages/store/src/io/board/verify.js', 'reasonCoded: () => (reason && REJECT_REASONS.includes(reason) ? null :', 'reasonCoded: () => (true ? null :']], VERDICT_RULES, 'red'],
  ['V5', 'a reject needs no note', [['packages/store/src/io/board/verify.js', `noteGiven: () => (suppliedNote ? null : new Refused('NOTE_REQUIRED', 'a reject says what failed: --note "..."')),`, 'noteGiven: () => null,']], VERDICT_RULES, 'red'],
  ['V6', 'a rejected head may be submitted again', [['packages/store/src/io/board/submit.js', "          return rejectedHead || sameReopenedHead\n            ? new Refused('HEAD_NOT_NEW'", "          return false\n            ? new Refused('HEAD_NOT_NEW'"]], ['apps/cli/journeys/resume/board.test.js', 'REJECT reopens the item'], 'red'],
  ['V6', 'a reject leaves the item submitted', [['packages/state/src/logic/machine/move/reject.js', "verb: 'reject', from: ['submitted', 'verified'], to: 'open',", "verb: 'reject', from: ['submitted', 'verified'], to: 'submitted',"]], ['apps/cli/journeys/resume/board.test.js', 'REJECT reopens the item'], 'red'],
  ['V7', 'verify runs from a checkout without the commit', [['apps/cli/src/io/commands/verify.js', 'if (!commit || !contains(root, commit, head)) {', 'if (!commit) {']], VERIFY_AT_COMMIT, 'red'],
  ['V8', "a verdict binds the verifier's head as the commit", [['packages/verify/src/logic/verdict/assurance.js', VERDICT_INSERT, VERDICT_INSERT.replace('item.item_commit', 'head')]], ['apps/cli/journeys/resume/board.test.js', 'every verdict binds the submitted commit'], 'red'],
  ['V8', 'a verdict binds no digest', [['packages/verify/src/logic/verdict/assurance.js', '    digest, head, family,', "    'none', head, family,"]], ['apps/cli/journeys/resume/board.test.js', 'every verdict binds the submitted commit'], 'red'],
  ['V9', 'the main checkout verifies without --as coordinator', [['apps/cli/src/io/verify.js', '  if (values.as === COORDINATOR) return;\n  const agents = store.listAgents(board)', '  return;\n  const agents = store.listAgents(board)']], VERIFY_AT_COMMIT, 'red'],
  ['V16', 'submit does not look whether the tree moved', [['apps/cli/src/io/commands/submit.js', MOVED, 'if (false) {']], MOVED_TREE, 'red'],
  ['V16', 'submit misses a commit made during the gate', [['apps/cli/src/io/commands/submit.js', MOVED, 'if (!isClean(root)) {']], MOVED_TREE, 'red'],
  ['V16', 'submit misses a tracked file edited during the gate', [['apps/cli/src/io/commands/submit.js', MOVED, 'if (headCommit(root) !== commit) {']], MOVED_TREE, 'red'],
];

audit(MUTANTS);
