/**
 * The proof that decision asks (B21) and typed evidence (B22) hold (item #60): each change below
 * breaks one part of them, and the tagged test must go red under it. The harness works on a
 * temporary copy, never a real checkout.
 *
 * Run it from the repo root: node docs/proof/shouts-mutants.mjs
 */
import { audit } from './harness.mjs';

const DECIDE = ['apps/cli/journeys/resume/board.test.js', 'a shout can ask for a decision'];
const EVIDENCE = ['apps/cli/journeys/resume/board.test.js', 'a shout can carry typed evidence'];
const CLI = ['apps/cli/journeys/spec/e2e.test.js', 'decisions are asked, listed and answered'];
const REPLY_CLOSES = ' AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id)';
const STORED = '.run(from, to, text.trim(), now(board), decision ? 1 : 0, answers, evidence?.kind ?? null,';

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['B21', 'an answer may name a shout that asked for nothing', [['packages/store/src/io/board/decision/answer.js', "if (!ask.shout_decision) throw new Refused('NOT_A_DECISION'", "if (false) throw new Refused('NOT_A_DECISION'"]], DECIDE, 'red'],
  ['B21', 'an answer never closes its ask', [['packages/store/src/io/board/query.js', REPLY_CLOSES, ''], ['packages/store/src/io/board/query.js', REPLY_CLOSES, ''], ['packages/store/src/io/board/query.js', REPLY_CLOSES, '']], DECIDE, 'red'],
  ['B21', 'a decision ask is stored as a plain shout', [['packages/store/src/io/board/shout.js', STORED, STORED.replace('decision ? 1 : 0', '0')]], DECIDE, 'red'],
  ['B21', 'an answer is stored without its ask', [['packages/store/src/io/board/shout.js', STORED, STORED.replace('decision ? 1 : 0, answers,', 'decision ? 1 : 0, null,')]], DECIDE, 'red'],
  ['B21', 'pullboard answer shouts to all, not the asker', [['packages/store/src/io/board/decision/answer.js', 'to: ask.shout_from, text, lanes, answers: id, channel', "to: 'all', text, lanes, answers: id, channel"]], CLI, 'red'],
  ['B21', 'pullboard decisions lists nothing', [['apps/cli/src/io/commands/decisions.js', "return { asks: projectRulingOwners(store.openDecisions(board, asPerson ? 'person' : [me.id, me.lane]),", 'return { asks: projectRulingOwners([],']], CLI, 'red'],
  ['B22', 'any kind of evidence passes', [['packages/store/src/logic/board/audience.js', 'if (!EVIDENCE_KINDS.includes(kind)) throw', 'if (false) throw']], EVIDENCE, 'red'],
  ['B22', 'evidence may leave out its outcome', [['packages/store/src/logic/board/audience.js', "if (!String(outcome ?? '').trim()) throw", 'if (false) throw']], EVIDENCE, 'red'],
  ['B22', 'evidence may name an item the board lacks', [['packages/store/src/logic/board/audience.js', "if (!Number.isInteger(item) || !board.db.prepare('SELECT 1 FROM item WHERE item_id = ?').get(item)) {", 'if (false) {']], EVIDENCE, 'red'],
  ['B22', 'evidence may name any text as its commit', [['packages/store/src/logic/board/audience.js', "if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw", 'if (false) throw']], EVIDENCE, 'red'],
  ['B22', 'the CLI passes on a commit it could not resolve', [['apps/cli/src/io/shout.js', 'if (resolved.status !== 0) throw', 'if (false) throw']], CLI, 'red'],
  ['B22', 'inbox hides the evidence', [['packages/activity/src/io/delivery/cli.js', 'if (shout.shout_evidence_kind) lines.push(', 'if (false) lines.push(']], CLI, 'red'],
];

audit(MUTANTS);
