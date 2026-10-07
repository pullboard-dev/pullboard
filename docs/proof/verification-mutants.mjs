/**
 * The proof audit of the verification rows, V1 to V9 (item #48) and V16 (item #51): for each row,
 * one or more changes to src/ that break the row's rule, and the tagged test that must go red under
 * each. The harness works on a temporary copy, never a real checkout.
 *
 * Run it from the repo root: node docs/proof/verification-mutants.mjs
 */
import { audit } from './harness.mjs';

const VERIFY_AT_COMMIT = ['test/e2e.test.js', 'verify runs at the submitted commit, against the criterion frozen at claim'];
const CLEAN_TREE = ['test/e2e.test.js', 'submit needs a clean tree, nothing untracked, and the gate green at HEAD'];
const VERDICT_RULES = ['test/board.test.js', 'ACCEPT needs CRITERION_MET'];
const BOARD_CRITERION = ['src/board.js', '        criterionUnchanged: (found) =>\n          digest === found.item_frozen_digest', '        criterionUnchanged: (found) =>\n          true || digest === found.item_frozen_digest'];
const CLI_CRITERION = ['src/cli.js', 'if (digest !== item.item_frozen_digest) {', 'if (false) {'];
const RED_GATE = ['src/cli.js', "if (!gate.isGreen) throw new Refused('GATE_RED'", "if (false) throw new Refused('GATE_RED'"];
const VERDICT_ROW = '.run(id, agentId, decision, code, note.trim(), found.item_commit, digest, head, now(board));';
const SUBMIT_RUN = 'const gate = runGate(root, ctx.config, { trustStamp: false });';
const MOVED = 'if (headCommit(root) !== commit || !isClean(root)) {';
const HAND_STAMP = ['test/gate.test.js', 'a stamp written by hand never stands in'];
const MOVED_TREE = ['test/gate.test.js', 'submit refuses a tree its gate left changed'];

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['V1', 'the builder may verify its own work', [['src/board.js', "notBuilder: (found) => (found.item_built_by === agentId ? new Refused('SELF_VERIFY', 'the builder never verifies its own work; another agent must') : null),", 'notBuilder: () => null,']], ['test/board.test.js', 'the builder never verifies its own work'], 'red'],
  ['V2', 'every claim refreezes the criterion', [['src/board.js', '          if (found.item_frozen_digest !== null) return null;\n', '']], ['test/board.test.js', 'the first claim freezes the criterion'], 'red'],
  ['V2', 'the freeze leaves out the title', [['src/spec.js', 'JSON.stringify({ title: item.item_title, criterion:', 'JSON.stringify({ criterion:']], ['test/spec.test.js', 'the frozen criterion covers title'], 'red'],
  ['V2', 'the freeze leaves out the cited row text', [['src/spec.js', 'return { id, text: row.text, gate: row.gate };', 'return { id, gate: row.gate };']], ['test/spec.test.js', 'the frozen criterion covers title'], 'red'],
  ['V3', 'the board takes a verdict against a moved criterion', [BOARD_CRITERION], ['test/board.test.js', 'a verdict against a moved criterion is refused'], 'red'],
  ['V3', 'the CLI and the board both take a moved criterion', [BOARD_CRITERION, CLI_CRITERION], VERIFY_AT_COMMIT, 'red'],
  ['V3', "the CLI's own check alone is removed; the board still refuses with the same code", [CLI_CRITERION], VERIFY_AT_COMMIT, 'green'],
  ['V4', 'submit takes a dirty tree', [['src/cli.js', "if (!isClean(root)) throw new Refused('DIRTY'", "if (false) throw new Refused('DIRTY'"]], CLEAN_TREE, 'red'],
  ['V4', 'submit takes untracked files', [['src/cli.js', "if (stray.length) throw new Refused('UNTRACKED'", "if (false) throw new Refused('UNTRACKED'"]], CLEAN_TREE, 'red'],
  ['V4', 'submit takes a red gate', [RED_GATE], ['test/e2e.test.js', 'a red gate refuses submit'], 'red'],
  ['V5', 'an accept needs no proof note', [['src/board.js', '        proofNoted: () =>\n          note.trim()', '        proofNoted: () =>\n          true || note.trim()']], VERDICT_RULES, 'red'],
  ['V5', 'an accept may give another reason', [['src/board.js', 'reasonIsMet: () => (reason && reason !== ACCEPT_REASON ?', 'reasonIsMet: () => (false ?']], VERDICT_RULES, 'red'],
  ['V5', 'a reject needs no reason code', [['src/board.js', 'reasonCoded: () => (reason && REJECT_REASONS.includes(reason) ? null :', 'reasonCoded: () => (true ? null :']], VERDICT_RULES, 'red'],
  ['V5', 'a reject needs no note', [['src/board.js', `noteGiven: () => (note.trim() ? null : new Refused('NOTE_REQUIRED', 'a reject says what failed: --note "..."')),`, 'noteGiven: () => null,']], VERDICT_RULES, 'red'],
  ['V6', 'a rejected head may be submitted again', [['src/board.js', "return wasRejected ? new Refused('HEAD_NOT_NEW'", "return false ? new Refused('HEAD_NOT_NEW'"]], ['test/board.test.js', 'REJECT reopens the item'], 'red'],
  ['V6', 'a reject leaves the item submitted', [['src/machine.js', "verb: 'reject', from: ['submitted'], to: 'open',", "verb: 'reject', from: ['submitted'], to: 'submitted',"]], ['test/board.test.js', 'REJECT reopens the item'], 'red'],
  ['V7', 'verify runs from a checkout without the commit', [['src/cli.js', 'if (!commit || !contains(root, commit, head)) {', 'if (!commit) {']], VERIFY_AT_COMMIT, 'red'],
  ['V8', "a verdict binds the verifier's head as the commit", [['src/board.js', VERDICT_ROW, VERDICT_ROW.replace('found.item_commit', 'head')]], ['test/board.test.js', 'every verdict binds the submitted commit'], 'red'],
  ['V8', 'a verdict binds no digest', [['src/board.js', VERDICT_ROW, VERDICT_ROW.replace('digest, head', "'none', head")]], ['test/board.test.js', 'every verdict binds the submitted commit'], 'red'],
  ['V9', 'the main checkout verifies without --as coordinator', [['src/cli.js', '  if (values.as === COORDINATOR) return;\n  const agents = store.listAgents(board)', '  return;\n  const agents = store.listAgents(board)']], VERIFY_AT_COMMIT, 'red'],
  ['V16', 'submit trusts a stamp written by hand', [['src/cli.js', SUBMIT_RUN, 'const gate = runGate(root, ctx.config);']], HAND_STAMP, 'red'],
  ['V16', "submit trusts an earlier run's stamp", [['src/cli.js', SUBMIT_RUN, 'const gate = runGate(root, ctx.config);']], ['test/gate.test.js', 'submit runs the gate even on a tree an earlier run passed'], 'red'],
  ['V16', 'the gate trusts the stamp whatever submit asks', [['src/gate.js', 'if (trustStamp && isStampedGreen(root))', 'if (isStampedGreen(root))']], HAND_STAMP, 'red'],
  ['V16', 'submit does not look whether the tree moved', [['src/cli.js', MOVED, 'if (false) {']], MOVED_TREE, 'red'],
  ['V16', 'submit misses a commit made during the gate', [['src/cli.js', MOVED, 'if (!isClean(root)) {']], MOVED_TREE, 'red'],
  ['V16', 'submit misses a tracked file edited during the gate', [['src/cli.js', MOVED, 'if (headCommit(root) !== commit) {']], MOVED_TREE, 'red'],
];

audit(MUTANTS);
