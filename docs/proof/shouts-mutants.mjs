/**
 * The proof that decision asks (B21) and typed evidence (B22) hold (item #60): each change below
 * breaks one part of them, and the tagged test must go red under it. The harness works on a
 * temporary copy, never a real checkout.
 *
 * Run it from the repo root: node docs/proof/shouts-mutants.mjs
 */
import { audit } from './harness.mjs';

const DECIDE = ['test/board.test.js', 'a shout can ask for a decision'];
const EVIDENCE = ['test/board.test.js', 'a shout can carry typed evidence'];
const CLI = ['test/e2e.test.js', 'decisions are asked, listed and answered'];
const STORED = '.run(from, to, text.trim(), now(board), decision ? 1 : 0, answers, evidence?.kind ?? null,';

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['B21', 'an answer may name a shout that asked for nothing', [['src/board.js', 'if (answers !== null && !getShout(board, answers).shout_decision) {', 'if (false) {']], DECIDE, 'red'],
  ['B21', 'an answer never closes its ask', [['src/board.js', ' AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id)', '']], DECIDE, 'red'],
  ['B21', 'a decision ask is stored as a plain shout', [['src/board.js', STORED, STORED.replace('decision ? 1 : 0', '0')]], DECIDE, 'red'],
  ['B21', 'an answer is stored without its ask', [['src/board.js', STORED, STORED.replace('decision ? 1 : 0, answers,', 'decision ? 1 : 0, null,')]], DECIDE, 'red'],
  ['B21', 'pullboard answer shouts to all, not the asker', [['src/cli.js', 'to: ask.shout_from, text:', "to: 'all', text:"]], CLI, 'red'],
  ['B21', 'pullboard decisions lists nothing', [['src/cli.js', 'const asks = withBoard(ctx, (board) => store.openDecisions(board));', 'const asks = [];']], CLI, 'red'],
  ['B22', 'any kind of evidence passes', [['src/board.js', 'if (!EVIDENCE_KINDS.includes(kind)) throw', 'if (false) throw']], EVIDENCE, 'red'],
  ['B22', 'evidence may leave out its outcome', [['src/board.js', "if (!String(outcome ?? '').trim()) throw", 'if (false) throw']], EVIDENCE, 'red'],
  ['B22', 'evidence may name an item the board lacks', [['src/board.js', "if (!Number.isInteger(item) || !board.db.prepare('SELECT 1 FROM item WHERE item_id = ?').get(item)) {", 'if (false) {']], EVIDENCE, 'red'],
  ['B22', 'evidence may name any text as its commit', [['src/board.js', "if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw", 'if (false) throw']], EVIDENCE, 'red'],
  ['B22', 'the CLI passes on a commit it could not resolve', [['src/cli.js', 'if (resolved.status !== 0) throw', 'if (false) throw']], CLI, 'red'],
  ['B22', 'inbox hides the evidence', [['src/cli.js', 'if (shout.shout_evidence_kind) io.say(', 'if (false) io.say(']], CLI, 'red'],
];

audit(MUTANTS);
