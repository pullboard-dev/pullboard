/** A decision names the items it changes, and each named item carries it [B29,B30,B31,N29,P6]. */
import assert from 'node:assert/strict';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, applyRelayMove, prepareEngineMove } from '../src/engine.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const sandboxes = [];
const SPEC = '# Implies fixture\n\n## G · Goals\n- G1 [approved, must] The feature works. | gate: test\n';
const HOUR = 3_600_000;

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** Make an isolated real-Git repo with a board, a coordinator, one joined web builder and three web items. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-implies-')));
  sandboxes.push(dir);
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !name.startsWith('GIT_CONFIG') && !name.startsWith('GIT_AUTHOR') && !name.startsWith('GIT_COMMITTER')) delete env[name];
  delete env.PULLBOARD_RELAY_TOKEN;
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  /** Run Git in this private fixture with its isolated identity. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  /** Run the actual CLI in a fixture checkout and keep both output streams. */
  const run = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '' };
  };
  /** Run a command that must succeed with --json and return its one document. */
  const json = (cwd, ...args) => {
    const result = run(cwd, ...args, '--json');
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
    return JSON.parse(result.out);
  };
  git(repo, 'init', '-q', '-b', 'main');
  assert.equal(run(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h',
    lanes: { web: { owns: ['web/'], specs: ['G1'] } },
  }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'shared.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: create implies fixture');
  const web = json(repo, 'worktree', 'web', '--route', 'strong').path;
  for (const title of ['First implied item', 'Second implied item', 'Untouched item']) {
    json(repo, 'add', 'web', title, '--specs', 'G1', '--criterion', `${title} works`, '--check', 'true');
  }
  return { dir, env, repo, web, run, json };
}

/** The facts in one item's thread, read through the real show command. */
function facts(box, id) {
  return box.json(box.repo, 'show', String(id)).thread.filter((entry) => entry.type === 'fact');
}

/** Count how many times a literal string occurs in a text. */
function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

test('[B29,B31,N29] a decision reaches the items it implies', () => {
  const box = fixture();
  assert.equal(box.json(box.web, 'claim', '1').id, 1);
  const ask = box.json(box.web, 'shout', 'coordinator', 'Which engine ships in 0.8.8?', '--kind', 'question', '--decision').id;
  const answer = box.json(box.repo, 'answer', String(ask), 'Ship engine 9 in 0.8.8\nso #1 and #2 move to engine 10', '--implies', '1,#2');

  for (const id of [1, 2]) {
    const implied = facts(box, id).filter((fact) => fact.decision);
    assert.equal(implied.length, 1, `#${id} carries the decision as one fact`);
    assert.deepEqual(implied[0].decision, { source: 'answer', id: answer.id, item: null, by: 'coordinator', line: 'Ship engine 9 in 0.8.8' },
      `#${id}'s fact cites the decision's id, who decided and its first line`);
    assert.equal(implied[0].supersededBy, undefined, 'an implied fact is not a supersession notice');
    assert.match(implied[0].text, new RegExp(`answer #${answer.id} by coordinator: Ship engine 9 in 0\\.8\\.8$`), 'the fact text names the decision for any reader');
    const shown = box.run(box.repo, 'show', String(id));
    assert.equal(shown.code, 0, shown.err);
    assert.ok(shown.out.includes(`implied by answer #${answer.id} by coordinator: Ship engine 9 in 0.8.8`), `pullboard show #${id} prints the implied fact`);
  }
  assert.deepEqual(facts(box, 3), [], 'an item not named carries nothing');

  const notice = `implied by answer #${answer.id} by coordinator: Ship engine 9 in 0.8.8`;
  const first = box.run(box.web, 'resume');
  assert.equal(first.code, 0, first.err);
  assert.equal(occurrences(first.out, notice), 1, `the holder's next resume shows the decision once:\n${first.out}`);
  assert.ok(first.out.includes(`#1 ${notice}`), 'the resume line names the held item');
  const second = box.run(box.web, 'resume');
  assert.equal(second.code, 0, second.err);
  assert.equal(occurrences(second.out, notice), 0, `a later resume does not repeat it:\n${second.out}`);

  const ask2 = box.json(box.web, 'shout', 'coordinator', 'Engine 9 slipped; what now?', '--kind', 'question', '--decision').id;
  const replacement = box.json(box.repo, 'answer', String(ask2), 'Ship engine 10 in 0.8.9 instead', '--supersedes', String(answer.id));
  for (const id of [1, 2]) {
    const told = facts(box, id).filter((fact) => fact.supersededBy);
    assert.equal(told.length, 1, `#${id} is told once that its decision was superseded`);
    assert.deepEqual(told[0].decision, { source: 'answer', id: answer.id, item: null, by: 'coordinator', line: 'Ship engine 9 in 0.8.8' }, 'the notice names the old decision');
    assert.deepEqual(told[0].supersededBy, { source: 'answer', id: replacement.id, item: null, by: 'coordinator', line: 'Ship engine 10 in 0.8.9 instead' }, 'the notice names the new decision');
    assert.match(told[0].text, new RegExp(`answer #${answer.id} by coordinator is superseded by answer #${replacement.id} by coordinator: Ship engine 10 in 0\\.8\\.9 instead$`));
  }
  assert.deepEqual(facts(box, 3), [], 'an item not named stays untouched by the supersession');
  const third = box.run(box.web, 'resume');
  assert.equal(occurrences(third.out, `is superseded by answer #${replacement.id}`), 1, `the holder's next resume shows the supersession once:\n${third.out}`);

  box.json(box.repo, 'fact', '3', 'decision', 'Keep #1 behind the engine flag', '--implies', '1');
  const why = box.json(box.repo, 'why', '1');
  assert.equal(why.id, 1);
  assert.deepEqual(why.decisions.map((entry) => [entry.source, entry.line, entry.supersededBy?.id ?? null]),
    [['fact', 'Keep #1 behind the engine flag', null], ['answer', 'Ship engine 9 in 0.8.8', replacement.id]],
    'pullboard why lists the decisions that imply an item, newest first, with supersession');
  const whyText = box.run(box.repo, 'why', '1');
  assert.equal(whyText.code, 0, whyText.err);
  assert.ok(whyText.out.indexOf('Keep #1 behind the engine flag') < whyText.out.indexOf('Ship engine 9 in 0.8.8'), `newest first in text:\n${whyText.out}`);
  assert.match(whyText.out, new RegExp(`superseded by answer #${replacement.id}`));
  assert.deepEqual(box.json(box.repo, 'why', '3').decisions, [], 'an item nothing implies has no decisions');
});

test('[B29,B31] verdicts and facts carry --implies; a later verdict or a superseding fact tells the items; unknown ids are refused by name', () => {
  const box = fixture();
  box.json(box.web, 'claim', '1');
  box.json(box.web, 'submit', '1', '--no-next');
  const review = box.json(box.repo, 'worktree', 'web', '--route', 'strong').path;
  box.json(review, 'next', '--verify');
  const refused = box.run(review, 'verify', '1', 'reject', '--no-next', '--reason', 'TEST_FAILURE', '--note', 'x', '--implies', '2,99', '--json');
  assert.notEqual(refused.code, 0);
  assert.equal(JSON.parse(refused.out).error.code, 'NO_ITEM');
  assert.match(JSON.parse(refused.out).error.message, /#99/, 'the refusal names the unknown id');
  assert.equal(box.json(box.repo, 'show', '1').item_status, 'submitted', 'a refused --implies records no verdict');
  box.json(review, 'verify', '1', 'reject', '--no-next', '--reason', 'TEST_FAILURE', '--clause', 'The feature works.', '--note', 'the fixture fails\nsecond line', '--implies', '2');
  const fromVerdict = facts(box, 2).filter((fact) => fact.decision);
  assert.equal(fromVerdict.length, 1);
  assert.equal(fromVerdict[0].decision.source, 'verdict');
  assert.equal(fromVerdict[0].decision.item, 1);
  assert.equal(fromVerdict[0].decision.line, 'reject TEST_FAILURE: the fixture fails');
  assert.equal(fromVerdict[0].by, fromVerdict[0].decision.by, 'the reviewer who decided authors the implied fact');
  box.json(box.web, 'claim', '1');
  writeFileSync(join(box.web, 'web', 'shared.txt'), 'fixed\n');
  runFixtureGit(['commit', '-q', '-am', 'fix: the fixture passes [G1]'], { cwd: box.web, env: box.env });
  const resubmitted = box.json(box.web, 'submit', '1', '--no-next').commit;
  box.json(review, 'next', '--verify');
  runFixtureGit(['switch', '-q', '--detach', resubmitted], { cwd: review, env: box.env });
  box.json(review, 'verify', '1', 'accept', '--no-next', '--note', 'ran the fixture check');
  const told = facts(box, 2).filter((fact) => fact.supersededBy);
  assert.equal(told.length, 1, 'a later verdict on the same item supersedes the earlier one for the items it implied');
  assert.equal(told[0].supersededBy.source, 'verdict');
  assert.equal(told[0].supersededBy.line, 'accept CRITERION_MET: ran the fixture check');

  const decision = box.json(box.repo, 'fact', '3', 'decision', 'Item 2 waits for engine 20', '--implies', '2').fact;
  box.json(box.repo, 'fact', '3', 'supersession', 'Item 2 waits for engine 19', '--supersedes', decision.id);
  const corrected = facts(box, 2).filter((fact) => fact.supersededBy?.source === 'fact');
  assert.equal(corrected.length, 1, 'superseding a fact that implied items tells each of them');
  assert.equal(corrected[0].decision.id, decision.id);
  assert.equal(corrected[0].supersededBy.line, 'Item 2 waits for engine 19');
  assert.equal(facts(box, 1).filter((fact) => fact.decision).length, 0, 'an item the fact never named is not told');
  const unknownFact = box.run(box.repo, 'fact', '3', 'note', 'stray', '--implies', '42', '--json');
  assert.equal(JSON.parse(unknownFact.out).error.code, 'NO_ITEM');
  const badList = box.run(box.repo, 'fact', '3', 'note', 'stray', '--implies', 'two', '--json');
  assert.equal(JSON.parse(badList.out).error.code, 'USAGE');
});

test('[P6,B26,H16] --implies cannot forge a person-origin fact through the relay, the API or the terminal', () => {
  let at = Date.parse('2026-10-17T00:00:00.000Z');
  const board = store.openBoard(':memory:', { now: () => new Date(at += 1000) });
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
  } finally { store.closeBoard(board); }
});

test('[B29,B31] every replica derives the same implied-fact ids for every supported move id', () => {
  /** Build one board the same way on each replica, with a fixed clock. */
  const replica = () => {
    let at = Date.parse('2026-10-17T00:00:00.000Z');
    const board = store.openBoard(':memory:', { now: () => new Date(at += 1000) });
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
      } finally { store.closeBoard(side.board); }
    }
    assert.equal(ids[0].length, 1, `a ${length}-character ${path} move id implies one fact`);
    assert.deepEqual(ids[0], ids[1], `a ${length}-character ${path} move id gives the same implied-fact id on both replicas`);
    assert.ok(ids[0][0].length <= 80, `the implied-fact id fits a fact id: ${ids[0][0]}`);
  }
});
