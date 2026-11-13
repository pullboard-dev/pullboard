/** A decision records where it came from, and pullboard why <file> names the decisions behind a file [N29,B29,P6]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';
import { DECISION_ORIGIN_ENGINE } from '../../../../packages/state/light.js';
import { originOf } from '../../../../packages/commits/src/logic/origin.js';
import { whyFile } from '../../../../packages/commits/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Real Git/SQLite items use public submit, verdict and native landing before file history is queried. */
async function fixture() {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.landing = { ...config.landing, manualOverride: true, publish: 'separate' };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  const seed = e2e.commitFile(box, box.repo, 'web/shared.txt', 'one\ntwo\nthree\n', 'chore: configure private why landing');
  assert.equal(seed.status, 0, seed.stderr);
  const other = e2e.commitFile(box, box.repo, 'web/other.txt', 'other\n', 'chore: seed other why history');
  assert.equal(other.status, 0, other.stderr);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  /** Return one public JSON result only after its native command succeeds. */
  async function json(cwd, ...args) {
    const result = await box.runLocal(cwd, ...args, '--json');
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
    return JSON.parse(result.out);
  }
  for (const [index, title] of ['First item', 'Second item'].entries()) {
    await json(box.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', `${title} exists`,
      '--check', `test -f web/built-${index + 1}`);
  }
  /** Land an actual submitted item, preserving its item trailer and durable merge receipt. */
  async function landItem(id, file, text) {
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    await json(box.web, 'claim', String(id));
    const result = e2e.commitFile(box, box.web, file, text, `feat(web): build why item ${id} [G1]`);
    assert.equal(result.status, 0, result.stderr);
    const flag = e2e.commitFile(box, box.web, `web/built-${id}`, 'built\n', `feat(web): complete why item ${id} [G1]`);
    assert.equal(flag.status, 0, flag.stderr);
    const submitted = await json(box.web, 'submit', String(id));
    box.git(box.repo, 'switch', '-q', '--detach', submitted.commit);
    try { await json(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The committed result exists.'); }
    finally { box.git(box.repo, 'switch', '-q', 'main'); }
    assert.deepEqual((await json(box.repo, 'land')).landed, [id]);
  }
  return { ...box, json, landItem };
}

test('a decision records its origin and pullboard why names the decisions behind a file [N29,B29,P6]', async () => {
  const box = await fixture();
  const web = box.web;

  const ask = (await box.json(web, 'shout', 'coordinator', 'Keep line two upper case?', '--kind', 'question', '--decision')).id;
  const answer = (await box.json(box.repo, 'answer', String(ask), 'Keep it upper case', '--implies', '1',
    '--origin', 'person-relayed', '--rationale', 'the person wants it to read as a heading')).id;
  const askOther = (await box.json(web, 'shout', 'coordinator', 'Change the other file?', '--kind', 'question', '--decision')).id;
  const answerOther = (await box.json(box.repo, 'answer', String(askOther), 'Change it', '--implies', '2')).id;

  const inheritedAsk = (await box.json(web, 'shout', 'coordinator', 'Keep the inherited convention?', '--kind', 'question', '--decision')).id;
  const inherited = (await box.json(box.repo, 'answer', String(inheritedAsk), 'Keep the convention', '--implies', '2',
    '--origin', 'inherited', '--rationale', 'the earlier design supplies no named decider')).id;
  const personAsk = (await box.json(box.repo, 'shout', 'person', 'Approve the other change?', '--decision')).id;
  const person = (await box.json(box.repo, 'answer', String(personAsk), 'I approve this change', '--as', 'person', '--implies', '2')).id;

  const third = (await box.json(web, 'shout', 'coordinator', 'One more?', '--kind', 'question', '--decision')).id;
  const forged = await box.runLocal(box.repo, 'answer', String(third), 'x', '--origin', 'person');
  assert.notEqual(forged.code, 0, 'an agent cannot name the person as the origin');
  assert.match(forged.err, /BAD_ORIGIN/u);

  await box.landItem(1, 'web/shared.txt', 'one\nTWO\nthree\n');
  await box.landItem(2, 'web/other.txt', 'other, changed\n');

  const file = await box.json(box.repo, 'why', 'web/shared.txt');
  assert.equal(file.file, 'web/shared.txt');
  assert.deepEqual(file.items.map((item) => item.id), [1], 'only the item whose landed commit touched the file');
  assert.deepEqual(file.rows.map((row) => row.id), ['G1']);
  assert.equal(file.decisions.length, 1, 'only the decision implying that item');
  assert.deepEqual({ id: file.decisions[0].id, statement: file.decisions[0].statement, rationale: file.decisions[0].rationale,
    decidedBy: file.decisions[0].decidedBy, relayedBy: file.decisions[0].relayedBy, origin: file.decisions[0].origin },
  { id: answer, statement: 'Keep it upper case', rationale: 'the person wants it to read as a heading',
    decidedBy: 'unknown', relayedBy: 'coordinator', origin: 'person-relayed' });

  const text = await box.runLocal(box.repo, 'why', 'web/shared.txt');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /person-relayed/u);
  assert.match(text.out, /Keep it upper case/u);

  assert.deepEqual((await box.json(box.repo, 'why', 'web/shared.txt:2')).items.map((item) => item.id), [1], 'the changed line');
  assert.deepEqual((await box.json(box.repo, 'why', 'web/shared.txt:1')).items, [], 'a line no landed commit touched');
  const other = await box.json(box.repo, 'why', 'web/other.txt');
  assert.deepEqual(other.decisions.map((entry) => [entry.id, entry.origin, entry.decidedBy]),
    [[answerOther, 'agent', 'coordinator'], [inherited, 'inherited', 'unknown'], [person, 'person', 'person']],
    'actual person answers and agent answers retain their authority; an inherited decider stays unknown');

  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    let queries = 0;
    const db = { prepare(sql) { queries += 1; return board.db.prepare(sql); } };
    assert.deepEqual(whyFile({ ...board, db }, box.repo, 'web/shared.txt').items.map(item => item.id), [1]);
    assert.equal(queries, 1, 'items, rows and answers resolve in one board query');
  } finally { store.closeBoard(board); }

  assert.equal(originOf({}), 'unknown', 'a decision with no recorded origin is unknown');
  assert.equal(originOf({ provenance: { origin: 'inherited' } }), 'inherited');
  assert.equal((await box.json(box.repo, 'why', 'web/missing.txt')).items.length, 0, 'a file no commit touched has nothing behind it');
  const pending = (await box.json(box.repo, 'add', 'web', 'Not landed', '--specs', 'G1', '--criterion', 'Pending exists', '--check', 'test -f web/not-landed')).item.item_id;
  box.git(web, 'merge', '-q', '--ff-only', 'main');
  await box.json(web, 'claim', String(pending));
  const unlanded = e2e.commitFile(box, web, 'web/shared.txt', 'one\nUNLANDED\nthree\n',
    `feat(web): pending change [G1]\n\nPullboard-Item: #${pending}`);
  assert.equal(unlanded.status, 0, unlanded.stderr);
  assert.deepEqual((await box.json(web, 'why', 'web/shared.txt')).items.map(item => item.id), [1],
    'a builder checkout cannot present its unlanded history as the primary branch');

});


test('decision origin and rationale retain their floor when an answer implies an item [H16,N29]', () => {
  for (const detail of [{ origin: 'agent' }, { rationale: 'the recorded reason' }]) {
    for (const options of [{ implies: [1] }, { cause: 'conflict:src/fixture.js' }, { cause: 'sentinel:fixture' }]) {
      const args = [1, { agentId: 'coordinator', text: 'Keep the change', ...options, ...detail }];
      assert.ok(minimumMoveEngine('answerDecision', args) >= DECISION_ORIGIN_ENGINE,
        `every mixed answer retains its recorded origin meaning: ${JSON.stringify(args)}`);
    }
  }
});
