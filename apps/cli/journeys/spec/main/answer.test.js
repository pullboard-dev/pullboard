/**
 * The spec (S1–S5): parsing SPEC.md rows, the lint, the frozen criterion and sign-offs.
 */
import assert from 'node:assert/strict';
import * as store from '../../../../../packages/store/index.js';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { RECORDED_GENERIC_NEXT } from '../../../../../packages/state/index.js';
import { specBox } from '../../../tests/fixtures/spec/box.js';
import { QUESTION_SPEC } from '../../../tests/fixtures/spec/box.js';
import { runIn } from '../../../tests/fixtures/spec/box.js';
import { viewMove } from '../../../tests/fixtures/spec/box.js';
import { boardRowDecisions } from '../../../tests/fixtures/spec/box.js';

test("spec answer records the person's choice [S1,E3,P6]", (t) => {
  const box = specBox(t, { specSource: QUESTION_SPEC });
  const file = join(box.root, box.specName);
  const line = (id) => readFileSync(file, 'utf8').split('\n').find((text) => text.startsWith(`- ${id} `));
  const before = readFileSync(file, 'utf8');

  const listed = box.run('answer', 'B1', 'postgres', '--json');
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const [record] = JSON.parse(listed.stdout).decisions;
  assert.deepEqual([record.id, record.decision, record.answer, record.text],
    ['B1', 'approve', 'Postgres', 'Which store holds the data: Postgres. Choices: SQLite, Postgres.'],
    'a listed choice matches in any case and keeps its listed spelling');
  assert.equal(record.by, 'person');
  assert.equal(readFileSync(file, 'utf8'), before, 'the answer waits for the coordinator apply, as an approval does');
  assert.match(box.run('show', 'B1').stdout, /answered Postgres, pending apply/u);
  const board = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    const stored = JSON.parse(board.prepare("SELECT meta_value FROM board_meta WHERE meta_key='row_decisions'").get().meta_value);
    board.prepare("UPDATE board_meta SET meta_value=? WHERE meta_key='row_decisions'")
      .run(JSON.stringify(stored.map((entry) => (entry.id === 'B1' ? { ...entry, answer: 'Tampered' } : entry))));
  } finally { board.close(); }
  const tampered = box.run('show', 'B1');
  assert.match(tampered.stdout, /answered Postgres, pending apply/u, 'the answer shown is read back from the signed text');
  assert.doesNotMatch(tampered.stdout, /Tampered/u, 'an unsigned answer field never changes what is shown');

  const oversized = box.run('answer', 'B5', 'r2', '--json');
  assert.equal(oversized.status, 1, oversized.stdout + oversized.stderr);
  const bound = JSON.parse(oversized.stdout).error;
  assert.equal(bound.code, 'SPEC_ANSWER_CHOICES', 'more than 12 choice parts is refused by name');
  assert.match(bound.message, /B5 lists 13 choice parts, more than the 12/u);
  assert.match(bound.next, /pullboard spec approve B5 --text/u);

  const free = box.run('answer', 'B2', 'Redis on the host');
  assert.equal(free.status, 0, free.stdout + free.stderr);
  assert.match(free.stdout, /^B2: answered Redis on the host, pending apply$/mu);

  const applied = box.run('apply');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(line('B1'), '- B1 [approved, must] Which store holds the data: Postgres. Choices: SQLite, Postgres. | gate: review',
    'the row leaves pending with the chosen answer');
  assert.equal(line('B2'), '- B2 [approved, must] Which store holds the cache: Redis on the host. Choices: SQLite, Postgres, Redis on the host. | gate: review',
    'an answer outside the choices is kept and joins them as the last choice');

  const view = viewMove(box, { verb: 'spec-answer', args: { row: 'B3', answer: 'SQLite' } }, 'view', { ...box.env, CLAUDECODE: '1' });
  assert.equal(view.status, 200, JSON.stringify(view));
  assert.equal(view.body.event.event_by, 'person');
  assert.equal(JSON.parse(view.body.event.event_detail).channel, 'view');
  assert.equal(view.body.result.decisions[0].answer, 'SQLite');
  assert.equal(box.run('apply').status, 0);
  assert.equal(line('B3'), '- B3 [approved, must] Which store holds the logs: SQLite. Choices: SQLite, Postgres. | gate: review',
    'the person answers from the view as well as the main checkout');

  const checked = box.run('check');
  assert.equal(checked.status, 0, `answers through the person path pass spec check: ${checked.stdout}${checked.stderr}`);

  const again = box.run('answer', 'B1', 'SQLite', '--json');
  assert.equal(again.status, 1);
  const error = JSON.parse(again.stdout).error;
  assert.equal(error.code, 'SPEC_ANSWER');
  assert.match(error.message, /B1 is approved, not a pending question/u);
  assert.match(error.next, /pullboard spec/u);
  assert.notEqual(error.next, RECORDED_GENERIC_NEXT);
});

test('approving an answered row keeps the answer [S1,E3]', (t) => {
  const box = specBox(t, { specSource: QUESTION_SPEC });
  const line = (id) => readFileSync(join(box.root, box.specName), 'utf8').split('\n').find((text) => text.startsWith(`- ${id} `));
  assert.equal(box.run('answer', 'B1', 'Postgres').status, 0);
  assert.equal(box.run('answer', 'B2', 'Redis on the host').status, 0);
  const agent = runIn(box, box.root, ['spec', 'approve', 'B1', '--json'], { ...box.env, CLAUDECODE: '1' });
  assert.equal(JSON.parse(agent.stdout).error.code, 'B26_PERSON_CHANNEL', 'an agent still cannot approve an answered row');
  const approved = box.run('approve', 'B1', 'B2', 'B3');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  const shown = box.run('show', 'B1').stdout;
  const applied = box.run('apply');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(line('B1'), '- B1 [approved, must] Which store holds the data: Postgres. Choices: SQLite, Postgres. | gate: review',
    'apply writes the answered choice');
  assert.doesNotMatch(line('B1'), /data: SQLite\./u, 'the original default is gone');
  assert.equal(line('B2'), '- B2 [approved, must] Which store holds the cache: Redis on the host. Choices: SQLite, Postgres, Redis on the host. | gate: review');
  assert.equal(line('B3'), '- B3 [approved, must] Which store holds the logs: SQLite. Choices: SQLite, Postgres. | gate: review');
  assert.match(shown, /answered Postgres, pending apply/u, 'spec show still names the pending answer');
  assert.match(approved.stdout, /^B1: approved with the answer Postgres, pending apply$/mu, 'the approve names the answer it keeps');
  assert.match(approved.stdout, /^B2: approved with the answer Redis on the host, pending apply$/mu);
  assert.match(approved.stdout, /^B3: approved, pending apply$/mu, 'a row with no answer approves as it reads');
});

test('approve --text names the answer it replaces [S1,E3]', (t) => {
  const box = specBox(t, { specSource: QUESTION_SPEC });
  const line = (id) => readFileSync(join(box.root, box.specName), 'utf8').split('\n').find((text) => text.startsWith(`- ${id} `));
  assert.equal(box.run('answer', 'B1', 'Postgres').status, 0);
  assert.equal(box.run('answer', 'B2', 'Postgres').status, 0);
  const choice = box.run('approve', 'B1', '--text', 'Which store holds the data: SQLite. Choices: SQLite, Postgres.');
  assert.equal(choice.status, 0, choice.stdout + choice.stderr);
  assert.match(choice.stdout, /^B1: this text replaces the pending answer Postgres with the answer SQLite$/mu, 'both answers are named');
  const free = box.run('approve', 'B2', '--text', 'The cache lives in memory.');
  assert.equal(free.status, 0, free.stdout + free.stderr);
  assert.match(free.stdout, /^B2: this text replaces the pending answer Postgres with "The cache lives in memory\."$/mu, 'a text that is no answer is named whole');
  assert.equal(box.run('answer', 'B3', 'Postgres').status, 0);
  const same = box.run('approve', 'B3', '--text', 'Which store holds the logs: Postgres. Choices: SQLite, Postgres.');
  assert.doesNotMatch(same.stdout, /replaces/u, 'the same text as the answer replaces nothing');
  assert.equal(box.run('apply').status, 0);
  assert.equal(line('B1'), '- B1 [approved, must] Which store holds the data: SQLite. Choices: SQLite, Postgres. | gate: review', 'the --text wins');
  assert.equal(line('B2'), '- B2 [approved, must] The cache lives in memory. | gate: review');
});

test('an agent cannot answer a pending row [P6,B26,E3]', (t) => {
  const box = specBox(t, { specSource: QUESTION_SPEC });
  const file = join(box.root, box.specName);
  const before = readFileSync(file, 'utf8');
  const decisions = boardRowDecisions(box);
  const spoofs = { PULLBOARD_PERSON: '1', PULLBOARD_AS: 'person', PULLBOARD_AGENT: 'person', PULLBOARD_CHANNEL: 'view',
    PULLBOARD_PERSON_CHANNEL: 'view', PULLBOARD_VIEW_FOREGROUND: '1', USER: 'person', LOGNAME: 'person' };
  const shells = [...AGENT_SHELL_MARKERS.map((marker) => ({ [marker]: 'agent-fixture', ...spoofs })),
    { CLAUDECODE: '1' }, { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22', ...spoofs }, { SSH_TTY: '/dev/ttys009' }];
  for (const shell of shells) {
    const name = Object.keys(shell).join('+');
    const refused = runIn(box, box.root, ['spec', 'answer', 'B1', 'Postgres', '--json'], { ...box.env, ...shell });
    assert.equal(refused.status, 1, `${name}: ${refused.stdout}${refused.stderr}`);
    const error = JSON.parse(refused.stdout).error;
    assert.equal(error.code, 'B26_PERSON_CHANNEL', name);
    assert.match(error.message, /the person/u, `${name}: the refusal names the person`);
    assert.match(error.next, /pullboard view/u, name);
    assert.notEqual(error.next, RECORDED_GENERIC_NEXT, name);
  }
  const flagged = runIn(box, box.root, ['spec', 'answer', 'B1', 'Postgres', '--as', 'person', '--json'], { ...box.env, CLAUDECODE: '1' });
  assert.equal(flagged.status, 1);
  assert.equal(JSON.parse(flagged.stdout).error.code, 'B26_PERSON_CHANNEL', 'no flag makes an agent the person: --as person is refused first');

  const api = viewMove(box, { verb: 'spec-answer', args: { row: 'B1', answer: 'Postgres' } }, 'api', box.env);
  assert.equal(api.status, 409, JSON.stringify(api));
  assert.equal(api.body.error.code, 'B26_PERSON_CHANNEL', 'the agent API is not the person channel');

  const made = box.command('worktree', 'review');
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const worktree = /^made (.+) on branch/mu.exec(made.stdout)[1];
  const agent = runIn(box, worktree, ['spec', 'answer', 'B1', 'Postgres', '--json']);
  assert.equal(agent.status, 1, agent.stdout + agent.stderr);
  const agentError = JSON.parse(agent.stdout).error;
  assert.equal(agentError.code, 'B26_PERSON_APPROVAL', 'an agent worktree is refused even from a clean terminal');
  assert.match(agentError.message, /only the person answers/u);
  assert.match(agentError.next, /pullboard shout coordinator.*--decision/u);
  assert.doesNotMatch(agentError.next, /ask the person|pullboard view/u);
  assert.equal(readFileSync(file, 'utf8'), before, 'refused answers leave the spec bytes alone');
  assert.equal(boardRowDecisions(box), decisions, 'refused answers record no row decision');

  writeFileSync(file, before
    .replace('[pending, must] Which store holds the data: SQLite.', '[approved, must] Which store holds the data: Postgres.')
    .replace('holds the cache: SQLite.', 'holds the cache: Postgres.'));
  const handEdited = box.run('check');
  assert.equal(handEdited.status, 1, handEdited.stdout + handEdited.stderr);
  assert.match(handEdited.stdout, /B1 error: pending question answered by hand; ask the person to run pullboard spec answer B1/u,
    'a hand edit that approves the question is flagged');
  assert.match(handEdited.stdout, /B2 error: pending question answered by hand; ask the person to run pullboard spec answer B2/u,
    'a hand edit that changes the answer of a still-pending question is flagged');
  assert.doesNotMatch(handEdited.stdout, /B3 error|B4 error/u, 'untouched questions stay quiet');
});
