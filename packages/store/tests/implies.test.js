/** A decision names the items it changes, and each named item carries it [B29,B30,B31,N29,P6]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../index.js';
import { applyEngineMove } from '../../state/index.js';
import { applyRelayMove } from '../../state/index.js';
import { decisionsImplying } from '../../state/index.js';
import { parseImplies } from '../../state/index.js';
import { prepareEngineMove } from '../../state/index.js';
import { takeDecisionNotices } from '../../state/index.js';
import { whyLine } from '../../state/index.js';
import { cellBoard } from './fixtures/cell.js';
import { cellItem } from './fixtures/cell.js';
import { cellProject } from './fixtures/cell.js';
import { cellSeat } from './fixtures/cell.js';
import { openCellBoard } from './fixtures/cell.js';
import { closeCellBoard } from './fixtures/cell.js';
import { submitFixture } from '../../../apps/cli/tests/fixtures/board/submit.js';

const HOUR = 3_600_000;

/** Freeze the criterion alone, with a digest of the frozen text. */
const freeze = (item) => {
  const text = JSON.stringify({ criterion: item.item_criterion });
  return { text, digest: createHash('sha256').update(text).digest('hex') };
};

/** A real-Git project and a board with a coordinator, one web builder, a reviewer and three web items, no CLI. */
function fixture(t) {
  const project = cellProject(t);
  mkdirSync(join(project.repo, 'web'), { recursive: true });
  writeFileSync(join(project.repo, 'web', 'shared.txt'), 'base\n');
  project.git(project.repo, 'add', '-A');
  project.git(project.repo, 'commit', '-q', '-m', 'chore: create implies fixture');
  const web = join(project.dir, 'web');
  project.git(project.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const builder = cellSeat(board, { lane: 'web', path: web }).id;
  const reviewer = cellSeat(board, { lane: 'web', path: join(project.dir, 'review') }).id;
  for (const title of ['First implied item', 'Second implied item', 'Untouched item']) {
    cellItem(board, { lane: 'web', title, specIds: ['G1'], criterion: `${title} works`, check: 'true' });
  }
  const claim = (id) => store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 2 * HOUR, freeze });
  /** Commit a change in the builder's checkout and submit it, as a build does; returns the submitted commit. */
  const build = (id, text, message) => {
    writeFileSync(join(web, 'web', 'shared.txt'), text);
    project.git(web, 'add', 'web/shared.txt');
    project.git(web, 'commit', '-q', '-m', message);
    const commit = project.git(web, 'rev-parse', 'HEAD');
    const policyCommit = project.git(project.repo, 'rev-parse', 'main');
    submitFixture(board, id, { agentId: builder, commit, tree: project.git(web, 'rev-parse', `${commit}^{tree}`), policyCommit, clausePolicyCommit: policyCommit, inspectClauses: true });
    return commit;
  };
  /** A verdict from the reviewer on the submitted commit. */
  const verdict = (id, commit, options) => store.verify(board, id, { agentId: reviewer, head: commit, digest: store.getItem(board, id).item_frozen_digest, policy: 'any', ...options });
  return { board, project, builder, reviewer, claim, build, verdict };
}

/** The facts in one item's thread. */
function facts(board, id) {
  return store.itemThread(board, id).filter((entry) => entry.type === 'fact');
}

test('[B29,B31,N29] a decision reaches the items it implies', (t) => {
  const { board, project, builder, claim } = fixture(t);
  const gitDir = join(project.repo, '.git');
  claim(1);
  const ask = store.shout(board, { from: builder, to: 'coordinator', text: 'Which engine ships in 0.8.8?', decision: true, lanes: ['web'] });
  const answer = store.answerDecision(board, ask, { agentId: 'coordinator', text: 'Ship engine 9 in 0.8.8\nso #1 and #2 move to engine 10', lanes: ['web'], implies: parseImplies('1,#2') });

  for (const id of [1, 2]) {
    const implied = facts(board, id).filter((fact) => fact.decision);
    assert.equal(implied.length, 1, `#${id} carries the decision as one fact`);
    assert.deepEqual(implied[0].decision, { source: 'answer', id: answer, item: null, by: 'coordinator', line: 'Ship engine 9 in 0.8.8' },
      `#${id}'s fact cites the decision's id, who decided and its first line`);
    assert.equal(implied[0].supersededBy, undefined, 'an implied fact is not a supersession notice');
    assert.match(implied[0].text, new RegExp(`answer #${answer} by coordinator: Ship engine 9 in 0\\.8\\.8$`), 'the fact text names the decision for any reader');
    assert.ok(implied[0].text.includes(`implied by answer #${answer} by coordinator: Ship engine 9 in 0.8.8`), `#${id}'s thread, which show prints, carries the implied fact`);
  }
  assert.deepEqual(facts(board, 3), [], 'an item not named carries nothing');

  const notice = `implied by answer #${answer} by coordinator: Ship engine 9 in 0.8.8`;
  /** What the holder's resume takes from the held item's thread. */
  const resume = () => takeDecisionNotices(gitDir, [{ item: 1, facts: store.itemThread(board, 1) }]);
  const first = resume();
  assert.equal(first.filter((entry) => entry.text.includes(notice)).length, 1, 'the holder\'s next resume shows the decision once');
  assert.equal(first[0].item, 1, 'the resume notice names the held item');
  assert.equal(resume().filter((entry) => entry.text.includes(notice)).length, 0, 'a later resume does not repeat it');

  const ask2 = store.shout(board, { from: builder, to: 'coordinator', text: 'Engine 9 slipped; what now?', decision: true, lanes: ['web'] });
  const replacement = store.answerDecision(board, ask2, { agentId: 'coordinator', text: 'Ship engine 10 in 0.8.9 instead', lanes: ['web'], supersedes: answer });
  for (const id of [1, 2]) {
    const told = facts(board, id).filter((fact) => fact.supersededBy);
    assert.equal(told.length, 1, `#${id} is told once that its decision was superseded`);
    assert.deepEqual(told[0].decision, { source: 'answer', id: answer, item: null, by: 'coordinator', line: 'Ship engine 9 in 0.8.8' }, 'the notice names the old decision');
    assert.deepEqual(told[0].supersededBy, { source: 'answer', id: replacement, item: null, by: 'coordinator', line: 'Ship engine 10 in 0.8.9 instead' }, 'the notice names the new decision');
    assert.match(told[0].text, new RegExp(`answer #${answer} by coordinator is superseded by answer #${replacement} by coordinator: Ship engine 10 in 0\\.8\\.9 instead$`));
  }
  assert.deepEqual(facts(board, 3), [], 'an item not named stays untouched by the supersession');
  assert.equal(resume().filter((entry) => entry.text.includes(`is superseded by answer #${replacement}`)).length, 1, 'the holder\'s next resume shows the supersession once');

  store.appendFact(board, 3, { agentId: 'coordinator', kind: 'decision', text: 'Keep #1 behind the engine flag', implies: parseImplies('1') });
  const why = decisionsImplying(store.itemThread(board, 1));
  assert.deepEqual(why.map((entry) => [entry.source, entry.line, entry.supersededBy?.id ?? null]),
    [['fact', 'Keep #1 behind the engine flag', null], ['answer', 'Ship engine 9 in 0.8.8', replacement]],
    'why lists the decisions that imply an item, newest first, with supersession');
  const lines = why.map(whyLine);
  assert.ok(lines[0].includes('Keep #1 behind the engine flag') && lines[1].includes('Ship engine 9 in 0.8.8'), 'newest first in text');
  assert.match(lines[1], new RegExp(`superseded by answer #${replacement}`));
  assert.deepEqual(decisionsImplying(store.itemThread(board, 3)), [], 'an item nothing implies has no decisions');
});

test('[B29,B31] verdicts and facts carry --implies; a later verdict or a superseding fact tells the items; unknown ids are refused by name', (t) => {
  const { board, reviewer, claim, build, verdict } = fixture(t);
  claim(1);
  const submittedDraft = build(1, 'draft\n', 'feat: the fixture draft [G1]');
  assert.throws(() => verdict(1, submittedDraft, { decision: 'REJECT', reason: 'TEST_FAILURE', clause: 'First implied item works', note: 'x', implies: [2, 99] }),
    (error) => error.code === 'NO_ITEM' && /#99/.test(error.message), 'the refusal names the unknown id');
  assert.equal(store.getItem(board, 1).item_status, 'submitted', 'a refused --implies records no verdict');
  verdict(1, submittedDraft, { decision: 'REJECT', reason: 'TEST_FAILURE', clause: 'First implied item works', note: 'the fixture fails\nsecond line', implies: [2] });
  const fromVerdict = facts(board, 2).filter((fact) => fact.decision);
  assert.equal(fromVerdict.length, 1);
  assert.equal(fromVerdict[0].decision.source, 'verdict');
  assert.equal(fromVerdict[0].decision.item, 1);
  assert.equal(fromVerdict[0].decision.line, 'reject TEST_FAILURE: the fixture fails');
  assert.equal(fromVerdict[0].by, fromVerdict[0].decision.by, 'the reviewer who decided authors the implied fact');
  assert.equal(fromVerdict[0].by, reviewer);
  claim(1);
  const resubmitted = build(1, 'fixed\n', 'fix: the fixture passes [G1]');
  verdict(1, resubmitted, { decision: 'ACCEPT', note: 'ran the fixture check' });
  const told = facts(board, 2).filter((fact) => fact.supersededBy);
  assert.equal(told.length, 1, 'a later verdict on the same item supersedes the earlier one for the items it implied');
  assert.equal(told[0].supersededBy.source, 'verdict');
  assert.equal(told[0].supersededBy.line, 'accept CRITERION_MET: ran the fixture check');

  const decision = store.appendFact(board, 3, { agentId: 'coordinator', kind: 'decision', text: 'Item 2 waits for engine 20', implies: parseImplies('2') });
  store.appendFact(board, 3, { agentId: 'coordinator', kind: 'supersession', text: 'Item 2 waits for engine 19', supersedes: decision.id });
  const corrected = facts(board, 2).filter((fact) => fact.supersededBy?.source === 'fact');
  assert.equal(corrected.length, 1, 'superseding a fact that implied items tells each of them');
  assert.equal(corrected[0].decision.id, decision.id);
  assert.equal(corrected[0].supersededBy.line, 'Item 2 waits for engine 19');
  assert.equal(facts(board, 1).filter((fact) => fact.decision).length, 0, 'an item the fact never named is not told');
  assert.throws(() => store.appendFact(board, 3, { agentId: 'coordinator', kind: 'note', text: 'stray', implies: parseImplies('42') }), { code: 'NO_ITEM' });
  assert.throws(() => parseImplies('two'), { code: 'USAGE' });
});

test('[P6,B26,H16] --implies cannot forge a person-origin fact through the relay, the API or the terminal', () => {
  let at = Date.parse('2026-10-17T00:00:00.000Z');
  const board = openCellBoard(':memory:', { now: () => new Date(at += 1000) });
  try {
    store.register(board, { lane: 'coordinator', path: '/repo' });
    store.register(board, { lane: 'web', path: '/repo-web-1' });
    const one = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'One' });
    const two = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Two' });
    store.claim(board, one, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze: (found) => ({ text: found.item_title, digest: 'd' }) });
    const personAsk = store.shout(board, { from: 'coordinator', to: 'person', text: 'Person decision', decision: true, lanes: ['web'] });
    const coordinator = { kind: 'agent', userId: 'user', agent: 'coordinator' };
    let sequence = 0;
    const relay = (move, sender = coordinator) => applyRelayMove(board, move, { sequence: ++sequence, at: new Date(at).toISOString(), sender, kind: 'move' });

    const forgedAnswer = relay(prepareEngineMove(board, 'answerDecision', [personAsk, { agentId: 'coordinator', asPerson: true, text: 'forged', lanes: ['web'], implies: [two] }]));
    assert.equal(forgedAnswer.error.code, 'RELAY_PERSON_ONLY', 'an agent cannot seal a person answer that implies items');
    const asCoordinator = relay(prepareEngineMove(board, 'answerDecision', [personAsk, { agentId: 'coordinator', text: 'forged', lanes: ['web'], implies: [two] }]));
    assert.equal(asCoordinator.error.code, 'B26_PERSON_ANSWER', 'the coordinator cannot answer the person decision for the person');
    const asPersonFact = relay(prepareEngineMove(board, 'appendFact', [one, { agentId: 'coordinator', kind: 'decision', text: 'Smuggled', implies: [two],
      by: 'person', asPerson: true, decision: { source: 'answer', id: personAsk, by: 'person', line: 'forged' } }]));
    assert.equal(asPersonFact.error?.code, 'RELAY_PERSON_ONLY', 'an agent cannot seal a fact as the person (#713) [D1]');
    const smuggled = relay(prepareEngineMove(board, 'appendFact', [one, { agentId: 'coordinator', kind: 'decision', text: 'Smuggled', implies: [two],
      by: 'person', decision: { source: 'answer', id: personAsk, by: 'person', line: 'forged' } }]));
    assert.equal(smuggled.error, undefined, JSON.stringify(smuggled.error));
    const carried = store.itemThread(board, two).filter((entry) => entry.type === 'fact' && entry.decision);
    assert.equal(carried.length, 1);
    assert.equal(carried[0].by, 'coordinator', 'the implied fact is stamped with the authenticated decider');
    assert.deepEqual(carried[0].decision, { source: 'fact', id: carried[0].decision.id, item: one, by: 'coordinator', line: 'Smuggled' }, 'caller fields never reach the citation');
    const person = store.itemThread(board, two).filter((entry) => entry.type === 'fact' && (entry.by === 'person' || entry.decision?.by === 'person'));
    assert.deepEqual(person, [], 'no person-origin fact exists after agent relays');

    const old = prepareEngineMove(board, 'appendFact', [one, { agentId: 'coordinator', kind: 'note', text: 'old engine', implies: [two] }]);
    old.engine = 19;
    const before = store.events(board).length;
    assert.throws(() => applyEngineMove(board, old, { sequence: sequence + 1, at: new Date(at).toISOString() }), { code: 'RELAY_MOVE' },
      'an implies move below engine 20 is refused before it is interpreted');
    assert.equal(store.events(board).length, before, 'the refused older move changes nothing');

    const personAnswer = store.answerDecision(board, personAsk, { agentId: 'coordinator', asPerson: true, text: 'The person decides', lanes: ['web'], implies: [two] });
    const real = store.itemThread(board, two).filter((entry) => entry.type === 'fact' && entry.decision?.source === 'answer');
    assert.deepEqual(real.map((entry) => [entry.by, entry.decision.by, entry.decision.id]), [['person', 'person', personAnswer]],
      "only the person's own answer yields a person-origin implied fact");
    const agentAsk = store.shout(board, { from: 'web-1', to: 'coordinator', text: 'Agent decision', decision: true, lanes: ['web'] });
    assert.throws(() => store.answerDecision(board, agentAsk, { agentId: 'coordinator', text: 'Overrule the person', lanes: ['web'], supersedes: personAnswer }),
      { code: 'B26_PERSON_ANSWER' }, "an agent cannot supersede the person's decision");
  } finally { closeCellBoard(board); }
});

test('[B29,B31] every replica derives the same implied-fact ids for every supported move id', () => {
  /** Build one board the same way on each replica, with a fixed clock. */
  const replica = () => {
    let at = Date.parse('2026-10-17T00:00:00.000Z');
    const board = openCellBoard(':memory:', { now: () => new Date(at += 1000) });
    store.register(board, { lane: 'coordinator', path: '/repo' });
    store.register(board, { lane: 'web', path: '/repo-web-1' });
    const one = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'One' });
    const two = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Two' });
    return { board, one, two };
  };
  for (const [path, length] of [1, 72, 73, 80].flatMap((n) => [['fact', n], ['answer', n]])) {
    const id = 'm'.repeat(length);
    const ids = [];
    for (const side of [replica(), replica()]) {
      try {
        const ask = store.shout(side.board, { from: 'web-1', to: 'coordinator', text: 'Which way?', decision: true, lanes: ['web'] });
        const move = path === 'fact'
          ? prepareEngineMove(side.board, 'appendFact', [side.one, { agentId: 'coordinator', kind: 'decision', text: `Boundary ${length}`, implies: [side.two] }], { id, actor: 'coordinator' })
          : prepareEngineMove(side.board, 'answerDecision', [ask, { agentId: 'coordinator', text: `Boundary ${length}`, lanes: ['web'], implies: [side.two] }], { id, actor: 'coordinator' });
        const applied = applyEngineMove(side.board, move, { sequence: 1, at: '2026-10-17T00:00:30.000Z' });
        assert.equal(applied.error, undefined, JSON.stringify(applied.error));
        ids.push(store.itemThread(side.board, side.two).filter((entry) => entry.type === 'fact' && entry.decision).map((entry) => entry.id));
      } finally { closeCellBoard(side.board); }
    }
    assert.equal(ids[0].length, 1, `a ${length}-character ${path} move id implies one fact`);
    assert.deepEqual(ids[0], ids[1], `a ${length}-character ${path} move id gives the same implied-fact id on both replicas`);
    assert.ok(ids[0][0].length <= 80, `the implied-fact id fits a fact id: ${ids[0][0]}`);
  }
});
