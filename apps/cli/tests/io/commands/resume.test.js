/** The coordinator's resume names a row the person approved that `spec apply` has not written yet, in text and in JSON [C7,I1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { withFixtureBoard } from '../../fixtures/board.js';
import { fileFixtureItem } from '../../fixtures/testkit.js';
import { specBoxInProcess } from '../../fixtures/spec/box.js';

/** The spec source with one draft row and no approved row, the state a new board is in. */
const DRAFT_ONLY = `# Demo

## G · Goals
- G1 [draft, must] The person can name the project. | gate: review
`;

test('cli.io-commands-resume.text-names-approved-row-pending-apply: clause 1: after spec approve G1 with no apply, the text resume names G1 as approved and pending apply [C7,I1]', async (t) => {
  const box = await specBoxInProcess(t, { specSource: DRAFT_ONLY });
  const approved = await box.spec('approve', 'G1');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  const resumed = await box.cmd('resume');
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /^approved by the person, pending apply: G1$/mu);
  assert.match(resumed.stdout, /^next: pullboard spec apply, then commit SPEC\.md$/mu, 'the text next step agrees with the JSON one');
  assert.doesNotMatch(resumed.stdout, /next: the person approves rows/u);
});

test('cli.io-commands-resume.text-drops-row-after-apply: clause 2: after spec apply, the text resume no longer names G1 [C7,I1]', async (t) => {
  const box = await specBoxInProcess(t, { specSource: DRAFT_ONLY });
  assert.equal((await box.spec('approve', 'G1')).status, 0);
  assert.equal((await box.spec('apply')).status, 0);
  const resumed = await box.cmd('resume');
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.doesNotMatch(resumed.stdout, /pending apply/u);
  assert.doesNotMatch(resumed.stdout, /spec apply/u, 'the next step no longer asks for an apply');
  const named = resumed.stdout.split('\n').filter((line) => /\bG1\b/u.test(line) && !line.startsWith('next: plan the approved rows'));
  assert.deepEqual(named, [], 'only the plan step may name the now-applied row');
});

test('cli.io-commands-resume.json-pending-apply-array: clause 3: pullboard resume --json prints a pendingApply array naming G1 [C7,I1]', async (t) => {
  const box = await specBoxInProcess(t, { specSource: DRAFT_ONLY });
  assert.equal((await box.spec('approve', 'G1')).status, 0);
  const resumed = await box.cmd('resume', '--json');
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const card = JSON.parse(resumed.stdout);
  assert.deepEqual(card.pendingApply, ['G1']);
  assert.equal(card.next, 'pullboard spec apply, then commit SPEC.md');
});

/** A box with one walled item (rejected twice, then released INELIGIBLE) and the machine setting next.returnedFirst as `setting` [C7,#11669]. */
function boxWithWall(t, setting) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Walled item' });
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify(setting === undefined ? settings : { ...settings, next: { returnedFirst: setting } }));
  withFixtureBoard(join(box.repo, '.git/pullboard/board.sqlite'), board => {
    const move = (kind, detail) => board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), 'fixture-seat', kind, item.item_id, JSON.stringify(detail));
    move('reject', { clause: 1, note: 'first reject' });
    move('reject', { clause: 1, note: 'second reject' });
    move('release', { reasonCode: 'INELIGIBLE', note: 'cannot be built as written' });
  });
  return { box, id: item.item_id };
}

const WALL_LINE = /^needs judgement: #\d+ wall, 3 attempts: cannot be built as written$/mu;

test('cli.io-commands-resume.coordinator-needs-judgement: clause 1: with next.returnedFirst on, the coordinator resume carries needsJudgement from the store reader and prints one line per entry [C7,#11669]', async t => {
  const { box, id } = boxWithWall(t, true);
  const json = JSON.parse((await box.runLocal(box.repo, 'resume', '--json')).out);
  assert.deepEqual(json.needsJudgement, [{ id, reason: 'wall', refusalText: 'cannot be built as written', attempts: 3 }]);
  const text = (await box.runLocal(box.repo, 'resume')).out;
  assert.match(text, WALL_LINE);
  assert.equal(text.split('\n').filter(line => line.startsWith('needs judgement: ')).length, 1, 'one line per entry');
});

test('cli.io-commands-resume.needs-judgement-coordinator-only: clause 2: a builder seat card, and the coordinator card with next.returnedFirst off or unset, carry no needsJudgement and print no such line [C7,#11669]', async t => {
  for (const setting of [false, undefined]) {
    const { box } = boxWithWall(t, setting);
    const json = JSON.parse((await box.runLocal(box.repo, 'resume', '--json')).out);
    assert.equal('needsJudgement' in json, false, `setting ${setting}: no key`);
    assert.doesNotMatch((await box.runLocal(box.repo, 'resume')).out, /needs judgement/u, `setting ${setting}: no line`);
  }
  const { box } = boxWithWall(t, true);
  assert.equal('needsJudgement' in JSON.parse((await box.runLocal(box.web, 'resume', '--json')).out), false, 'a builder seat carries none');
  assert.doesNotMatch((await box.runLocal(box.web, 'resume')).out, /needs judgement/u);
});
