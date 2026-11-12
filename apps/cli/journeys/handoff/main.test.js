/** Agent replacement uses a real board, worktrees and authenticated replay [B3,N19,H16]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import {
  appliedSequence,
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { HANDOFF_ENGINE } from '../../../../packages/state/light.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { loadDoctrine } from '../../../../packages/doctrine/index.js';
import {
  frozenCriterion,
  loadSpec,
} from '../../../../packages/spec/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';

/** Keep fixture identity, settings, Git and SQLite separate from the invoking agent. */
function fixture(t, { registrationEngine = ENGINE_VERSION, replayEngine = ENGINE_VERSION } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-handoff-'))), root = join(directory, 'repo');
  mkdirSync(root);
  const overrides = { PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Fixture\n\n## B\n- B3 [approved, must] An agent is its worktree. | gate: review\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '# Fixture\n\n## T\n- T1 [approved, must] Real isolated state. | gate: review\n');
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-q', '-m', 'test: isolated handoff fixture [B3]'], { cwd: root, env });
  const settings = machineSettingsFile(); mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false } }));
  const clock = { value: Date.parse('2026-10-24T10:00:00Z'), now() { return new Date(this.value); } };
  const board = openBoard(join(root, '.git/pullboard/board.sqlite'), clock);
  // Historical replay tests need actual old join bytes, not current grants followed by an old move.
  board.executionEngineVersion = registrationEngine;
  store.register(board, { lane: 'coordinator', path: root });
  const paths = ['outgoing', 'incoming', 'other'].map(name => join(directory, name));
  const agents = paths.map(path => {
    runFixtureGit(['worktree', 'add', '--detach', '--quiet', path, 'main'], { cwd: root, env });
    return store.register(board, { lane: 'core', path });
  });
  delete board.executionEngineVersion;
  /** Execute real CLI parsing/dispatch, with text available to prove the final printed command. */
  async function cli(index, args, json = true) {
    let output = '', error = '';
    const code = await main([...args, ...(json ? ['--json'] : [])], { cwd: index === null ? root : paths[index], clock,
      stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write: value => { error += value; } } });
    return { code, output, error, document: json && output ? JSON.parse(output) : null };
  }
  /** Replay only with the relay's independent authenticated seat, retaining refusal outcomes. */
  function replay(operation, args, sender, engine = replayEngine) {
    const move = prepareEngineMove(board, operation, args);
    if (engine !== undefined) move.engine = engine;
    return applyRelayMove(board, move, { sequence: appliedSequence(board) + 1, at: clock.now().toISOString(), kind: 'move',
      sender: { kind: 'agent', agent: sender, userId: 'fixture-user' } });
  }
  t.after(() => {
    store.closeBoard(board); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  return { directory, root, paths, agents, board, clock, cli, replay };
}

test('handoff takeover prints real work and retires only the outgoing seat [B3,N19,H16]', async t => {
  const box = fixture(t), [outgoing, incoming] = box.agents;
  const item = store.addItem(box.board, { by: 'coordinator', lane: 'core', title: 'Owned work', route: 'strong', criterion: 'Keep the actual claim.' });
  const config = loadConfig(box.root);
  store.claim(box.board, item, { agentId: outgoing, lane: 'core', leaseMs: 3_600_000,
    freeze: row => frozenCriterion(loadSpec(box.root, config), row, loadDoctrine(box.root, config)) });
  writeFileSync(join(box.paths[0], 'unfinished.txt'), 'unfinished ownership');
  const ask = store.shout(box.board, { from: outgoing, to: incoming, text: 'Which edge is next?', decision: true, lanes: ['core'] });
  store.answerDecision(box.board, ask, { agentId: incoming, text: 'Preserve the replay edge.', lanes: ['core'] });
  const opened = await box.cli(0, ['handoff']);
  assert.equal(opened.code, 0, opened.error);
  const id = opened.document.handoff.item;
  assert.equal(opened.document.resume.claims[0].item_id, item);
  assert.match(opened.document.resume.worktree.changes, /unfinished.txt/u);
  assert.equal(opened.document.resume.asks[0].answers[0].shout_text, 'Preserve the replay edge.');
  assert.ok(opened.document.resume.moves.some(move => move.event_kind === 'claim'));
  assert.match(opened.document.stillToWrite.join(' '), /principles and taste.*open threads.*files outside.*only this chat/iu);
  const again = await box.cli(0, ['handoff'], false);
  assert.equal(again.code, 0, again.error);
  assert.ok(again.output.trimEnd().endsWith(`pullboard shout --item ${id} "Hand-off complete; ask any remaining questions here."`));
  assert.equal(store.events(box.board).filter(row => row.event_kind === 'handoff-open').length, 1);
  const fact = await box.cli(0, ['fact', String(id), 'note', 'Outside scratch file and the reason for this approach.']);
  assert.equal(fact.code, 0, fact.error);
  box.clock.value += 1_000;
  const taken = await box.cli(1, ['handoff', '--take', String(id)]);
  assert.equal(taken.code, 0, taken.error || JSON.stringify(taken.document));
  assert.equal(taken.document.handoff.takenAt, box.clock.now().toISOString());
  assert.equal(taken.document.resume.agent, outgoing);
  assert.ok(taken.document.facts.some(row => row.text.includes('Outside scratch')));
  assert.ok(taken.document.facts.some(row => row.kind === 'note' && row.text.includes(box.clock.now().toISOString())));
  assert.equal(store.getItem(box.board, item).item_owner, outgoing, 'takeover reports claims; it does not silently reassign work');
  const beforeBlockedFact = store.events(box.board).length;
  const blocked = await box.cli(0, ['fact', String(id), 'note', 'not a permitted post-takeover move']);
  assert.equal(blocked.document.error.code, 'AGENT_REPLACED');
  assert.equal(store.events(box.board).length, beforeBlockedFact, 'a refused fact leaves no partial event');
  assert.match(blocked.document.error.message, new RegExp(incoming, 'u'));
  assert.equal((await box.cli(0, ['shout', 'coordinator', 'a different channel'])).document.error.code, 'AGENT_REPLACED');
  assert.equal((await box.cli(0, ['shout', '--item', String(item), 'wrong item'])).document.error.code, 'AGENT_REPLACED');
  assert.equal((await box.cli(0, ['shout', '--item', String(id), 'The final context is here.'])).code, 0);
  const inbox = await box.cli(1, ['inbox']);
  assert.ok(inbox.document.shouts.some(row => row.shout_text === 'The final context is here.'));
  assert.equal((await box.cli(1, ['shout', '--item', String(id), 'One last question.'])).code, 0);
  const beforeRetiredRead = store.events(box.board).length;
  const retiredInbox = await box.cli(0, ['inbox']);
  assert.equal(retiredInbox.code, 0, retiredInbox.error);
  assert.ok(retiredInbox.document.shouts.some(row => row.shout_text === 'One last question.'));
  assert.equal(retiredInbox.document.activity.receipt.recorded, false);
  assert.equal(retiredInbox.document.activity.receipt.code, 'AGENT_REPLACED');
  assert.equal(store.events(box.board).length, beforeRetiredRead, 'reading a retired seat does not record a delivery');
  const retiredAck = await box.cli(0, ['inbox', '--acted-on', 'event:1']);
  assert.equal(retiredAck.document.error.code, 'AGENT_REPLACED');
  assert.equal(store.events(box.board).length, beforeRetiredRead, 'retirement still blocks acknowledgements without partial writes');
  assert.equal(readFileSync(join(box.paths[0], 'unfinished.txt'), 'utf8'), 'unfinished ownership');
});

test('handoff takeover is first-wins and cannot be forged by facts or an authenticated old engine [B3,H16]', t => {
  // Keep the whole historical prefix at its real engine; a current receipt activates newer grants.
  const box = fixture(t, { registrationEngine: HANDOFF_ENGINE, replayEngine: HANDOFF_ENGINE }), [outgoing, incoming, other] = box.agents;
  const opened = box.replay('openHandoff', [{ agentId: outgoing }], outgoing);
  assert.equal(opened.error, undefined);
  const id = opened.result.item;
  assert.equal(box.replay('takeHandoff', [{ agentId: outgoing, item: id }], outgoing).error.code, 'HANDOFF_SELF');
  store.appendFact(box.board, id, { agentId: incoming, kind: 'note', text: 'I took over at an invented time.' });
  const beforeTake = box.replay('addItem', [{ by: outgoing, lane: 'core', title: 'Still active', route: 'strong' }], outgoing, 1);
  assert.equal(beforeTake.error, undefined, 'historical pre-takeover engine semantics remain valid');
  assert.equal(box.replay('takeHandoff', [{ agentId: incoming, item: id }], outgoing).error.code, 'RELAY_SENDER_MISMATCH');
  assert.equal(box.replay('takeHandoff', [{ agentId: incoming, item: beforeTake.result }], incoming).error.code, 'NO_HANDOFF');
  assert.equal(box.replay('takeHandoff', [{ agentId: incoming, item: id }], incoming).error, undefined);
  assert.equal(box.replay('takeHandoff', [{ agentId: incoming, item: id }], incoming).error, undefined);
  assert.equal(box.replay('takeHandoff', [{ agentId: other, item: id }], other).error.code, 'HANDOFF_TAKEN');
  assert.equal(store.events(box.board).filter(row => row.event_kind === 'handoff-take').length, 1);
  const count = store.listItems(box.board, { all: true }).length;
  assert.equal(box.replay('addItem', [{ by: incoming, lane: 'core', title: 'Spoof incoming', route: 'strong' }], outgoing).error.code, 'RELAY_SENDER_MISMATCH', 'authentication refusals stay auditable after retirement');
  for (const engine of [1, ENGINE_VERSION]) {
    assert.equal(box.replay('addItem', [{ by: outgoing, lane: 'core', title: 'Old actor must fail', route: 'strong' }], outgoing, engine).error.code, 'AGENT_REPLACED');
  }
  assert.equal(store.listItems(box.board, { all: true }).length, count);
  // After the explicit current-engine probe, the activated prefix requires current moves.
  assert.equal(box.replay('register', [{ lane: 'core', path: join(box.directory, 'escape'), createdBy: outgoing }], outgoing, ENGINE_VERSION).error.code, 'AGENT_REPLACED');
  assert.equal(box.replay('shout', [{ from: outgoing, to: 'coordinator', text: 'wrong target', lanes: ['core'] }], outgoing, ENGINE_VERSION).error.code, 'AGENT_REPLACED');
  assert.equal(box.replay('shout', [{ from: outgoing, item: id, text: 'allowed answer', lanes: ['core'] }], outgoing, ENGINE_VERSION).error, undefined);
  assert.equal(box.replay('addItem', [{ by: incoming, lane: 'core', title: 'Incoming can work', route: 'strong' }], incoming, ENGINE_VERSION).error, undefined);
});

test('handoff rejects main and ordinary items, and a closed untaken channel is replaced [B3,N19]', async t => {
  const box = fixture(t), [outgoing, incoming] = box.agents;
  assert.equal((await box.cli(null, ['handoff'])).document.error.code, 'HANDOFF_WORKTREE');
  const first = store.openHandoff(box.board, { agentId: outgoing });
  store.withdraw(box.board, first.item, { agentId: 'coordinator', reason: 'Start a fresh active hand-off.' });
  const next = store.openHandoff(box.board, { agentId: outgoing });
  assert.notEqual(next.item, first.item);
  assert.throws(() => store.takeHandoff(box.board, { agentId: incoming, item: first.item }), error => error.code === 'NO_HANDOFF');
  assert.equal(store.takeHandoff(box.board, { agentId: incoming, item: next.item }).incoming, incoming);
  const beforeRefusedFact = store.events(box.board).length;
  assert.throws(() => store.appendFact(box.board, next.item, { agentId: outgoing, kind: 'note', text: 'direct store is also refused' }), error => error.code === 'AGENT_REPLACED');
  assert.equal(store.events(box.board).length, beforeRefusedFact);
});
